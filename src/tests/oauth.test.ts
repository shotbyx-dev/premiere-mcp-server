/**
 * OAuth 2.1 + DCR tests: redirect-URI policy, scope model, token store
 * (codes, rotation, replay revocation), the full HTTP authorization-code
 * flow, the 401 discovery challenge, and audience binding.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildVerifier, createMcpAuthMiddleware, tokensEqual } from '../auth.js';
import { fetchClientMetadataDocument } from '../oauth/cimd.js';
import { renderConsentPage } from '../oauth/consent.js';
import { authorizeRedirectAllowed, validateRedirectUri } from '../oauth/redirects.js';
import { createOAuthRouter, publicBaseForRequest } from '../oauth/router.js';
import {
  normalizeScopes,
  requiredScopeForTool,
  satisfiesScope,
} from '../oauth/scopes.js';
import { newSecret, TokenStore } from '../oauth/store.js';
import { checkToolScope } from '../server.js';

// ---------------------------------------------------------------------------
// Redirect-URI policy
// ---------------------------------------------------------------------------

describe('redirect URI policy', () => {
  const good = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector/oauth/callback',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth',
    'http://127.0.0.1:9876/callback',
    'http://127.0.0.1/callback',
    'http://localhost:3000/callback',
    'http://[::1]:8080/callback',
  ];
  for (const uri of good) {
    it(`accepts ${uri}`, () => {
      assert.equal(validateRedirectUri(uri).ok, true, uri);
    });
  }

  const evil = [
    'https://evil.com/callback',
    'https://chatgpt.com.evil.com/connector/oauth/x', // subdomain trick
    'https://chatgpt.com@evil.com/connector/oauth/', // userinfo trick
    'https://user:pass@chatgpt.com/connector/oauth/', // userinfo, period
    'http://evil.com/callback',
    'https://chatgpt.com/other', // wrong path
    'https://chatgpt.com/connector/oauth-evil', // prefix must end at boundary
    'https://claude.ai/api/mcp/auth_callback/extra', // exact-match only
    'http://127.0.0.1:8080/other', // wrong path
    'https://127.0.0.1:8080/callback', // loopback must be http
    'https://chatgpt.com/connector/oauth#frag', // fragments leak codes
    'not a url',
    '',
  ];
  for (const uri of evil) {
    it(`rejects ${uri || '(empty)'}`, () => {
      assert.equal(validateRedirectUri(uri).ok, false, uri);
    });
  }

  it('authorizeRedirectAllowed requires exact registration + policy', async () => {
    const store = new TokenStore(null);
    const client = await store.registerClient({
      client_id: 'client_x',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      scope: ['read'],
    });
    assert.equal(authorizeRedirectAllowed(client, 'http://127.0.0.1:9999/callback').ok, true);
    assert.equal(
      authorizeRedirectAllowed(client, 'http://127.0.0.1:8888/callback').ok,
      false,
      'unregistered port must fail even though the shape is allowed'
    );
    assert.equal(authorizeRedirectAllowed(client, 'https://evil.com/callback').ok, false);
  });
});

// ---------------------------------------------------------------------------
// Scope model
// ---------------------------------------------------------------------------

describe('scope model', () => {
  it('normalizes legacy "mcp" to read+write (never admin)', () => {
    assert.deepEqual(normalizeScopes('mcp offline_access'), ['read', 'write', 'offline_access']);
  });
  it('drops unknown scopes and defaults to read', () => {
    assert.deepEqual(normalizeScopes('bogus nonsense'), ['read']);
    assert.deepEqual(normalizeScopes(''), ['read']);
    assert.deepEqual(normalizeScopes(undefined), ['read']);
  });
  it('keeps admin when explicitly requested', () => {
    assert.deepEqual(normalizeScopes(['admin', 'read']), ['admin', 'read']);
  });

  it('satisfiesScope: admin grants everything', () => {
    assert.equal(satisfiesScope(['admin'], 'admin'), true);
    assert.equal(satisfiesScope(['admin'], 'write'), true);
    assert.equal(satisfiesScope(['admin'], 'read'), true);
  });
  it('satisfiesScope: write implies read, not admin', () => {
    assert.equal(satisfiesScope(['write'], 'read'), true);
    assert.equal(satisfiesScope(['write'], 'write'), true);
    assert.equal(satisfiesScope(['write'], 'admin'), false);
    assert.equal(satisfiesScope(['read'], 'write'), false);
  });
  it('satisfiesScope: legacy mcp grants read+write, never admin', () => {
    assert.equal(satisfiesScope(['mcp'], 'read'), true);
    assert.equal(satisfiesScope(['mcp'], 'write'), true);
    assert.equal(satisfiesScope(['mcp'], 'admin'), false);
  });
  it('satisfiesScope: no scopes grants nothing', () => {
    assert.equal(satisfiesScope([], 'read'), false);
    assert.equal(satisfiesScope(undefined, 'read'), false);
  });

  it('requiredScopeForTool derives from annotations', () => {
    const ro = { name: 'get_project_info', annotations: { readOnlyHint: true, destructiveHint: false } };
    const wr = { name: 'add_to_timeline', annotations: { readOnlyHint: false, destructiveHint: false } };
    const de = { name: 'remove_from_timeline', annotations: { readOnlyHint: false, destructiveHint: true } };
    assert.equal(requiredScopeForTool(ro), 'read');
    assert.equal(requiredScopeForTool(wr), 'write');
    assert.equal(requiredScopeForTool(de), 'admin');
  });
  it('requiredScopeForTool: execute_extendscript is admin ALWAYS', () => {
    assert.equal(
      requiredScopeForTool({
        name: 'execute_extendscript',
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
      'admin'
    );
  });
  it('requiredScopeForTool: explicit scope override wins', () => {
    assert.equal(
      requiredScopeForTool({
        name: 'x',
        scope: 'admin',
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
      'admin'
    );
  });
});

describe('checkToolScope', () => {
  const readTool = {
    name: 'get_project_info',
    title: 't',
    description: 'd',
    inputSchema: {} as never,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async () => ({}),
  };
  const adminTool = {
    name: 'execute_extendscript',
    title: 't',
    description: 'd',
    inputSchema: {} as never,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async () => ({}),
  };

  it('read token calling an admin tool is denied (403/insufficient_scope)', () => {
    const r = checkToolScope({ scopes: ['read'] } as never, adminTool);
    assert.deepEqual(r, { ok: false, required: 'admin' });
  });
  it('write token calling an admin tool is denied', () => {
    const r = checkToolScope({ scopes: ['read', 'write'] } as never, adminTool);
    assert.deepEqual(r, { ok: false, required: 'admin' });
  });
  it('admin token calling an admin tool is allowed', () => {
    assert.deepEqual(checkToolScope({ scopes: ['admin'] } as never, adminTool), { ok: true });
  });
  it('read token calling a read tool is allowed', () => {
    assert.deepEqual(checkToolScope({ scopes: ['read'] } as never, readTool), { ok: true });
  });
  it('missing auth (non-HTTP transport) is denied', () => {
    assert.deepEqual(checkToolScope(undefined, readTool), { ok: false, required: 'read' });
  });
});

// ---------------------------------------------------------------------------
// Token store: codes, rotation, replay revocation
// ---------------------------------------------------------------------------

describe('token store', () => {
  it('auth codes are single-use', async () => {
    const store = new TokenStore(null);
    const code = await store.issueCode({
      client_id: 'c1',
      redirect_uri: 'http://127.0.0.1:1/callback',
      scope: ['read'],
      code_challenge: 'x'.repeat(43),
      resource: 'https://mcp.example.com/mcp',
    });
    const first = await store.consumeCode(code);
    assert.ok(first, 'first consume works');
    assert.equal(first.client_id, 'c1');
    assert.equal(await store.consumeCode(code), null, 'second consume fails');
  });

  it('expired auth codes are rejected', async () => {
    const store = new TokenStore(null);
    const code = await store.issueCode({
      client_id: 'c1',
      redirect_uri: 'http://127.0.0.1:1/callback',
      scope: ['read'],
      code_challenge: 'x'.repeat(43),
      resource: 'https://mcp.example.com/mcp',
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await store.consumeCode(code), null);
  });

  it('secrets are hashed at rest', async () => {
    const store = new TokenStore(null);
    const access = await store.issueAccessToken({
      client_id: 'c1',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
      family: 'fam',
    });
    const raw = JSON.stringify((store as unknown as { data: unknown }).data);
    assert.ok(!raw.includes(access), 'raw token value must not appear in the store');
  });

  it('refresh rotation issues a new pair and retires the old token', async () => {
    const store = new TokenStore(null);
    const { token: r1 } = await store.issueRefreshToken({
      client_id: 'c1',
      scope: ['read', 'offline_access'],
      resource: 'https://mcp.example.com/mcp',
    });
    const rotated = await store.rotateRefresh(r1);
    assert.equal(rotated.ok, true);
    if (rotated.ok) {
      // New tokens are usable…
      const rec = await store.getToken(rotated.refreshToken);
      assert.ok(rec && rec.status === 'active' && rec.kind === 'refresh');
      // …and the old refresh token is marked rotated.
      const old = await store.getToken(r1);
      assert.equal(old?.status, 'rotated');
    }
  });

  it('replaying a rotated refresh token revokes the whole family', async () => {
    const store = new TokenStore(null);
    const { token: r1 } = await store.issueRefreshToken({
      client_id: 'c1',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
    });
    const rotated = await store.rotateRefresh(r1);
    assert.equal(rotated.ok, true);
    // Attacker replays the stolen old token:
    const replay = await store.rotateRefresh(r1);
    assert.deepEqual(replay, { ok: false, reason: 'replayed' });
    // The family's fresh tokens are dead too:
    if (rotated.ok) {
      assert.deepEqual(await store.rotateRefresh(rotated.refreshToken), {
        ok: false,
        reason: 'revoked',
      });
      const access = await store.getToken(rotated.accessToken);
      assert.equal(access?.status, 'revoked');
    }
  });

  it('revoking a refresh token kills the family (RFC 7009)', async () => {
    const store = new TokenStore(null);
    const { token: r1 } = await store.issueRefreshToken({
      client_id: 'c1',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
    });
    const access = await store.issueAccessToken({
      client_id: 'c1',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
      family: 'fam',
    });
    void access;
    assert.equal(await store.revokeTokenValue(r1), true);
    assert.deepEqual(await store.rotateRefresh(r1), { ok: false, reason: 'revoked' });
    assert.equal(await store.revokeTokenValue(newSecret()), false, 'unknown token -> false');
  });

  it('persists to disk with 0600 perms and reloads', async () => {
    const { mkdtemp, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
    const file = join(dir, 'oauth.json');
    const s1 = new TokenStore(file);
    await s1.registerClient({ client_id: 'persist_me', redirect_uris: [], scope: ['read'] });
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, `oauth.json should be 0600, got ${mode.toString(8)}`);
    const s2 = new TokenStore(file);
    assert.ok(await s2.getClient('persist_me'), 'client survives reload');
  });
});

// ---------------------------------------------------------------------------
// CIMD + consent page units
// ---------------------------------------------------------------------------

describe('cimd + consent', () => {
  it('rejects non-https metadata URLs without network', async () => {
    assert.equal(await fetchClientMetadataDocument('http://127.0.0.1/nope'), null);
  });
  it('consent page shows the public-URL warning when unconfigured', () => {
    const html = renderConsentPage({
      fields: {
        client_id: 'c', redirect_uri: 'r', scope: 'read', state: '',
        code_challenge: 'x', code_challenge_method: 'S256', resource: 'y',
      },
      clientName: 'Test',
      scopes: ['read'],
      publicUrlWarning: true,
    });
    assert.ok(html.includes('PREMIERE_MCP_PUBLIC_URL'));
    assert.ok(html.includes('Owner passphrase'));
    assert.ok(html.includes('value="approve"') && html.includes('value="deny"'));
  });
});

// ---------------------------------------------------------------------------
// Full HTTP flow: DCR -> authorize -> token -> refresh -> revoke
// ---------------------------------------------------------------------------

describe('oauth http flow', () => {
  const OWNER = 'test-owner-secret-123456';
  const PUBLIC = 'https://mcp.example.com';
  let store: TokenStore;
  let base = '';
  let http: import('node:http').Server;

  const REDIRECT = 'http://127.0.0.1:54321/callback';
  let clientId = '';

  function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    return { verifier, challenge };
  }

  async function postForm(path: string, params: Record<string, string>) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      redirect: 'manual',
    });
    return res;
  }

  /** Run authorize (GET validation + POST approve) and return the issued code. */
  async function authorizeFlow(scope: string, passphrase: string) {
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope,
      state: 'state123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${PUBLIC}/mcp`,
    });
    const get = await fetch(`${base}/authorize?${params.toString()}`, { redirect: 'manual' });
    assert.equal(get.status, 200, 'consent page renders');
    const html = await get.text();
    assert.ok(html.includes('Test Client'), 'consent shows client name');

    const post = await postForm('/authorize', {
      action: 'approve',
      passphrase,
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope,
      state: 'state123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${PUBLIC}/mcp`,
    });
    return { post, verifier };
  }

  before(async () => {
    store = new TokenStore(null);
    const app = express();
    app.use(
      createOAuthRouter({
        store,
        ownerSecret: OWNER,
        publicUrl: PUBLIC,
        publicUrlWarning: false,
        secretsEqual: tokensEqual,
      })
    );
    // Probe route behind the real /mcp auth middleware for 401/audience tests.
    const verifier = buildVerifier({ staticToken: 'x'.repeat(32), store });
    app.post(
      '/mcp-probe',
      createMcpAuthMiddleware({
        verifier,
        metadataUrlFor: (req) => `${publicBaseForRequest(req, PUBLIC)}/.well-known/oauth-protected-resource`,
        resourceFor: (req) => `${publicBaseForRequest(req, PUBLIC)}/mcp`,
      }),
      (_req, res) => res.json({ ok: true })
    );
    await new Promise<void>((resolve) => {
      http = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  after(
    () =>
      new Promise<void>((resolve, reject) =>
        http.close((e) => (e ? reject(e) : resolve()))
      )
  );

  it('serves RFC 8414 authorization-server metadata (+ openid-configuration alias)', async () => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200);
      const md = (await res.json()) as Record<string, unknown>;
      assert.equal(md.issuer, PUBLIC);
      assert.equal(md.authorization_endpoint, `${PUBLIC}/authorize`);
      assert.equal(md.token_endpoint, `${PUBLIC}/token`);
      assert.equal(md.registration_endpoint, `${PUBLIC}/register`);
      assert.deepEqual(md.response_types_supported, ['code']);
      assert.deepEqual(md.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(md.token_endpoint_auth_methods_supported, ['none']);
      assert.equal(md.client_id_metadata_document_supported, true);
      assert.ok((md.scopes_supported as string[]).includes('offline_access'));
    }
  });

  it('serves RFC 9728 protected-resource metadata (+ path variant)', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200);
      const md = (await res.json()) as Record<string, unknown>;
      assert.equal(md.resource, `${PUBLIC}/mcp`);
      assert.deepEqual(md.authorization_servers, [PUBLIC]);
    }
  });

  it('DCR accepts a good registration', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test Client',
        redirect_uris: [REDIRECT],
        scope: 'read write offline_access',
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(String(body.client_id).startsWith('client_'));
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.ok(!('client_secret' in body), 'public client gets no secret');
    clientId = String(body.client_id);
  });

  it('DCR rejects an evil redirect_uri', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Evil',
        redirect_uris: ['https://evil.com/steal'],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'invalid_redirect_uri');
  });

  it('DCR rejects confidential-client metadata', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    assert.equal(res.status, 400);
  });

  it('authorize rejects an unknown client without redirecting', async () => {
    const res = await fetch(
      `${base}/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${'x'.repeat(43)}`,
      { redirect: 'manual' }
    );
    assert.equal(res.status, 400);
  });

  it('authorize rejects an unregistered redirect_uri without redirecting', async () => {
    const { challenge } = pkce();
    const res = await fetch(
      `${base}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.com/x')}&response_type=code&code_challenge=${challenge}`,
      { redirect: 'manual' }
    );
    assert.equal(res.status, 400, 'must not redirect to an untrusted URI');
  });

  it('authorize denies with a wrong owner passphrase', async () => {
    const { post } = await authorizeFlow('read write offline_access', 'wrong-pass');
    assert.equal(post.status, 403);
    assert.ok((await post.text()).includes('Wrong owner passphrase'));
  });

  it('full code flow: approve -> token (PKCE) -> use access token', async () => {
    const { post, verifier } = await authorizeFlow('read write offline_access', OWNER);
    assert.equal(post.status, 302);
    const location = post.headers.get('location') ?? '';
    assert.ok(location.startsWith(REDIRECT), `redirects to client: ${location}`);
    const code = new URL(location).searchParams.get('code');
    assert.ok(code, 'code issued');
    assert.equal(new URL(location).searchParams.get('state'), 'state123');

    const tokenRes = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token, 'access token issued');
    assert.ok(tokens.refresh_token, 'offline_access granted a refresh token');
    assert.equal(tokens.expires_in, 3600);

    // The access token passes the real /mcp auth middleware.
    const probe = await fetch(`${base}/mcp-probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(probe.status, 200);

    // …and a second use of the same code fails (single-use).
    const reuse = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    assert.equal(reuse.status, 400);
    assert.equal(((await reuse.json()) as Record<string, unknown>).error, 'invalid_grant');
  });

  it('token rejects a wrong PKCE verifier', async () => {
    const { post } = await authorizeFlow('read', OWNER);
    assert.equal(post.status, 302);
    const code = new URL(post.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    const res = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: 'wrong-verifier-' + 'x'.repeat(40),
      client_id: clientId,
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Record<string, unknown>).error, 'invalid_grant');
  });

  it('refresh rotation works; replaying the old token revokes the family', async () => {
    const { post, verifier } = await authorizeFlow('read offline_access', OWNER);
    const code = new URL(post.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    const t1 = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    const first = (await t1.json()) as Record<string, unknown>;
    const r1 = String(first.refresh_token);
    assert.ok(r1);

    const t2 = await postForm('/token', { grant_type: 'refresh_token', refresh_token: r1 });
    assert.equal(t2.status, 200);
    const second = (await t2.json()) as Record<string, unknown>;
    assert.ok(second.access_token && second.refresh_token);

    // Replay the old refresh token -> invalid_grant, family revoked.
    const replay = await postForm('/token', { grant_type: 'refresh_token', refresh_token: r1 });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as Record<string, unknown>).error, 'invalid_grant');

    // The rotated (honest) refresh token is dead too.
    const after = await postForm('/token', {
      grant_type: 'refresh_token',
      refresh_token: String(second.refresh_token),
    });
    assert.equal(after.status, 400);
  });

  it('revoke always returns 200 and kills the token', async () => {
    const { post, verifier } = await authorizeFlow('read offline_access', OWNER);
    const code = new URL(post.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    const t = await postForm('/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
    });
    const tokens = (await t.json()) as Record<string, unknown>;
    const access = String(tokens.access_token);

    const revoke = await postForm('/revoke', { token: String(tokens.refresh_token) });
    assert.equal(revoke.status, 200);

    // Family revocation took the access token with it.
    const probe = await fetch(`${base}/mcp-probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}` },
    });
    assert.equal(probe.status, 401, 'revoked access token is rejected');

    // Unknown tokens still get 200 (no oracle).
    const unknown = await postForm('/revoke', { token: 'nope' });
    assert.equal(unknown.status, 200);
  });

  it('unauthenticated /mcp returns 401 with the resource_metadata discovery challenge', async () => {
    const res = await fetch(`${base}/mcp-probe`, { method: 'POST' });
    assert.equal(res.status, 401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    assert.ok(challenge.includes('Bearer'), 'Bearer challenge');
    assert.ok(
      challenge.includes(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`),
      `discovery URL in challenge: ${challenge}`
    );
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'invalid_token');
  });

  it('a token issued for a different server (wrong audience) is rejected', async () => {
    const foreign = await store.issueAccessToken({
      client_id: 'client_x',
      scope: ['admin'],
      resource: 'https://other.example.com/mcp',
      family: 'fam_foreign',
    });
    const res = await fetch(`${base}/mcp-probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${foreign}` },
    });
    assert.equal(res.status, 401);
  });

  it('the static bearer token still works as the admin owner', async () => {
    const res = await fetch(`${base}/mcp-probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(32)}` },
    });
    assert.equal(res.status, 200);
  });
});
