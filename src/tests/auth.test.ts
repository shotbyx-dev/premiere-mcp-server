import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifier, extractBearerToken, tokensEqual } from '../auth.js';
import { newSecret, TokenStore } from '../oauth/store.js';

const STATIC = 'correct-token-1234567890';

function verifierWithStore() {
  const store = new TokenStore(null); // in-memory
  return { store, verifier: buildVerifier({ staticToken: STATIC, store }) };
}

describe('bearer auth', () => {
  it('accepts the static token as the admin-scoped owner', async () => {
    const { verifier } = verifierWithStore();
    const info = await verifier.verifyAccessToken(STATIC);
    assert.equal(info.clientId, 'owner:bearer');
    assert.deepEqual(info.scopes, ['admin']);
    assert.ok((info.expiresAt ?? 0) > Math.floor(Date.now() / 1000));
  });

  it('rejects a wrong token with an OAuth error', async () => {
    const { verifier } = verifierWithStore();
    await assert.rejects(() => verifier.verifyAccessToken('wrong-token'), /Invalid or expired/);
  });

  it('rejects an empty token', async () => {
    const { verifier } = verifierWithStore();
    await assert.rejects(() => verifier.verifyAccessToken(''), /Invalid or expired/);
  });

  it('accepts an OAuth access token with oauth:<client_id> identity', async () => {
    const { store, verifier } = verifierWithStore();
    const access = await store.issueAccessToken({
      client_id: 'client_abc',
      scope: ['read', 'write'],
      resource: 'https://mcp.example.com/mcp',
      family: 'fam_1',
    });
    const info = await verifier.verifyAccessToken(access);
    assert.equal(info.clientId, 'oauth:client_abc');
    assert.deepEqual(info.scopes, ['read', 'write']);
  });

  it('rejects an unknown OAuth-shaped token', async () => {
    const { verifier } = verifierWithStore();
    await assert.rejects(() => verifier.verifyAccessToken(newSecret()), /Invalid or expired/);
  });

  it('rejects an expired access token', async () => {
    const { store, verifier } = verifierWithStore();
    const access = await store.issueAccessToken({
      client_id: 'client_abc',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
      family: 'fam_1',
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(() => verifier.verifyAccessToken(access), /Invalid or expired/);
  });

  it('rejects a revoked access token', async () => {
    const { store, verifier } = verifierWithStore();
    const access = await store.issueAccessToken({
      client_id: 'client_abc',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
      family: 'fam_1',
    });
    assert.ok(await store.revokeTokenValue(access));
    await assert.rejects(() => verifier.verifyAccessToken(access), /Invalid or expired/);
  });

  it('rejects a refresh token used as an access token', async () => {
    const { store, verifier } = verifierWithStore();
    const { token } = await store.issueRefreshToken({
      client_id: 'client_abc',
      scope: ['read'],
      resource: 'https://mcp.example.com/mcp',
    });
    await assert.rejects(() => verifier.verifyAccessToken(token), /Invalid or expired/);
  });

  it('tokensEqual is length-safe and constant-time', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('abc', 'abcd'), false); // different lengths, no throw
    assert.equal(tokensEqual('', ''), true);
  });

  it('extractBearerToken parses the Authorization header', () => {
    assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
    assert.equal(extractBearerToken('bearer abc123'), 'abc123');
    assert.equal(extractBearerToken('Basic abc123'), null);
    assert.equal(extractBearerToken(undefined), null);
    assert.equal(extractBearerToken('Bearer '), null);
  });
});
