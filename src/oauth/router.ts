/**
 * OAuth 2.1 authorization server, co-hosted with the MCP resource server in
 * this single binary (spec-legal: no third-party IdP, self-issued opaque
 * tokens).
 *
 * Endpoints (all mounted on the same Express app as /mcp):
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /.well-known/oauth-protected-resource/mcp   (path variant)
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /.well-known/openid-configuration            (alias, for ChatGPT)
 *   POST /register    RFC 7591 dynamic client registration (public clients)
 *   GET  /authorize   validate request -> owner consent page
 *   POST /authorize   passphrase + approve/deny -> 302 with code|error
 *   POST /token       authorization_code + refresh_token grants (PKCE S256,
 *                     refresh rotation with replay revocation)
 *   POST /revoke      RFC 7009 (always 200)
 *
 * Discovery metadata is served dynamically from the request host so the
 * issuer matches the fetch origin behind the Cloudflare tunnel; when
 * PREMIERE_MCP_PUBLIC_URL is configured it is authoritative instead.
 */
import { createHash } from 'node:crypto';
import express, {
  type Request,
  type RequestHandler,
  type Router,
} from 'express';
import { fetchClientMetadataDocument } from './cimd.js';
import { renderAuthorizeErrorPage, renderConsentPage, type ConsentFields } from './consent.js';
import { authorizeRedirectAllowed, validateRedirectUri } from './redirects.js';
import { normalizeScopes, SCOPES_SUPPORTED } from './scopes.js';
import {
  ACCESS_TOKEN_TTL_MS,
  newId,
  TokenStore,
  type StoredClient,
} from './store.js';

export interface OAuthRouterDeps {
  store: TokenStore;
  /** Resolved owner passphrase for the consent gate. */
  ownerSecret: string;
  /** Public URL configured via PREMIERE_MCP_PUBLIC_URL, or null. */
  publicUrl: string | null;
  /** True when PREMIERE_MCP_PUBLIC_URL is unset (warn on the consent page). */
  publicUrlWarning: boolean;
  /** Constant-time string compare (imported from auth to avoid duplication). */
  secretsEqual: (a: string, b: string) => boolean;
}

/** Public base URL for this request: configured URL wins, else request host. */
export function publicBaseForRequest(req: Request, configured: string | null): string {
  if (configured) return configured.replace(/\/+$/, '');
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost')
    .split(',')[0]
    .trim();
  return `https://${host}`;
}

function protectedResourceUrl(base: string): string {
  return `${base}/mcp`;
}

function oauthError(res: express.Response, status: number, error: string, description: string) {
  return res.status(status).json({ error, error_description: description });
}

/** Resolve a client_id: registered client, or CIMD https-URL doc (upserted). */
async function resolveClient(
  store: TokenStore,
  clientId: string
): Promise<StoredClient | null> {
  if (!clientId) return null;
  const known = await store.getClient(clientId);
  if (known) return known;
  if (!/^https:\/\//.test(clientId)) return null;
  const doc = await fetchClientMetadataDocument(clientId);
  if (!doc) return null;
  // Upsert so /token and audit see a stable record; re-fetch refreshes it.
  return store.registerClient({
    client_id: clientId,
    client_name: doc.client_name,
    redirect_uris: doc.redirect_uris,
    scope: normalizeScopes(doc.scope),
    cimd: clientId,
  });
}

function metadataRouter(deps: OAuthRouterDeps): Router {
  const r = express.Router();

  const protectedResource = (_req: Request, res: express.Response) => {
    const base = publicBaseForRequest(_req, deps.publicUrl);
    res.json({
      resource: protectedResourceUrl(base),
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: [...SCOPES_SUPPORTED],
      resource_name: 'PremierePilot MCP server',
    });
  };
  r.get('/.well-known/oauth-protected-resource', protectedResource);
  r.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const authServer = (_req: Request, res: express.Response) => {
    const base = publicBaseForRequest(_req, deps.publicUrl);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES_SUPPORTED],
      client_id_metadata_document_supported: true,
    });
  };
  r.get('/.well-known/oauth-authorization-server', authServer);
  // ChatGPT probes the OIDC discovery alias.
  r.get('/.well-known/openid-configuration', authServer);

  return r;
}

// ---------------------------------------------------------------------------
// POST /register — RFC 7591 dynamic client registration (public clients only)
// ---------------------------------------------------------------------------

function registerHandler(deps: OAuthRouterDeps): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirect_uris = body.redirect_uris;
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array');
      return;
    }
    for (const uri of redirect_uris) {
      if (typeof uri !== 'string') {
        oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be strings');
        return;
      }
      const check = validateRedirectUri(uri);
      if (!check.ok) {
        oauthError(res, 400, 'invalid_redirect_uri', `redirect_uri rejected: ${uri} (${check.reason})`);
        return;
      }
    }
    // Public clients only: no secrets issued, auth method must be 'none'.
    const authMethod = body.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== 'none') {
      oauthError(res, 400, 'invalid_client_metadata', "token_endpoint_auth_method must be 'none' (public clients only)");
      return;
    }
    const grantTypes = body.grant_types;
    if (grantTypes !== undefined) {
      const allowed = new Set(['authorization_code', 'refresh_token']);
      const list = Array.isArray(grantTypes) ? grantTypes : [];
      if (!list.every((g) => allowed.has(String(g)))) {
        oauthError(res, 400, 'invalid_client_metadata', 'grant_types must be a subset of ["authorization_code","refresh_token"]');
        return;
      }
    }

    const client_name =
      typeof body.client_name === 'string' && body.client_name.length <= 120
        ? body.client_name
        : undefined;
    const scope = normalizeScopes(
      typeof body.scope === 'string' ? body.scope : Array.isArray(body.scope) ? body.scope : undefined
    );
    const client = await deps.store.registerClient({
      client_id: newId('client'),
      client_name,
      redirect_uris: redirect_uris as string[],
      scope,
    });
    res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      scope: client.scope.join(' '),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  };
}

// ---------------------------------------------------------------------------
// GET /authorize — validate the request, render the owner consent page
// ---------------------------------------------------------------------------

interface AuthorizeRequest {
  client: StoredClient;
  redirect_uri: string;
  scope: string[];
  state: string;
  code_challenge: string;
  resource: string;
}

function redirectWithError(
  res: express.Response,
  redirectUri: string,
  error: string,
  state: string,
  description?: string
) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  res.redirect(302, u.toString());
}

async function parseAuthorizeRequest(
  store: TokenStore,
  query: Record<string, unknown>,
  base: string
): Promise<
  | { ok: true; value: AuthorizeRequest }
  | { ok: false; redirectable: false; error: string }
  | { ok: false; redirectable: true; redirect_uri: string; error: string; description: string; state: string }
> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const client_id = str(query.client_id);
  const redirect_uri = str(query.redirect_uri);
  const state = str(query.state);
  const failRedirect = (error: string, description: string) =>
    ({
      ok: false,
      redirectable: true,
      redirect_uri,
      error,
      description,
      state,
    }) as const;

  const client = await resolveClient(store, client_id);
  if (!client) {
    return { ok: false, redirectable: false, error: 'Unknown client_id. Register via POST /register first.' };
  }
  // redirect_uri must be registered AND policy-clean. On failure we must NOT
  // redirect (the URI itself is untrusted) — render an error page instead.
  const allowed = authorizeRedirectAllowed(client, redirect_uri);
  if (!allowed.ok) {
    return { ok: false, redirectable: false, error: `redirect_uri rejected: ${allowed.reason}` };
  }
  if (str(query.response_type) !== 'code') {
    return failRedirect('unsupported_response_type', 'response_type must be "code"');
  }
  const code_challenge = str(query.code_challenge);
  const method = str(query.code_challenge_method) || 'S256';
  if (!code_challenge) {
    return failRedirect('invalid_request', 'code_challenge (PKCE) is required');
  }
  if (method !== 'S256') {
    return failRedirect('invalid_request', 'code_challenge_method must be S256');
  }
  if (code_challenge.length < 43 || code_challenge.length > 128) {
    return failRedirect('invalid_request', 'code_challenge has an invalid length');
  }
  // Scope: normalize the request, then require it to be within the grant.
  const requested = normalizeScopes(str(query.scope) || undefined);
  const granted = requested.filter((s) => client.scope.includes(s));
  if (granted.length !== requested.length) {
    return failRedirect('invalid_scope', 'requested scope exceeds the registered grant');
  }
  const resource = str(query.resource) || protectedResourceUrl(base);
  if (resource !== protectedResourceUrl(base)) {
    return failRedirect('invalid_target', 'resource must be this server\'s /mcp URL');
  }
  return {
    ok: true,
    value: { client, redirect_uri, scope: granted, state, code_challenge, resource },
  };
}

function authorizeGetHandler(deps: OAuthRouterDeps): RequestHandler {
  return async (req, res) => {
    const base = publicBaseForRequest(req, deps.publicUrl);
    const parsed = await parseAuthorizeRequest(
      deps.store,
      req.query as Record<string, unknown>,
      base
    );
    if (!parsed.ok) {
      if (parsed.redirectable) {
        redirectWithError(res, parsed.redirect_uri, parsed.error, parsed.state, parsed.description);
      } else {
        res.status(400).send(renderAuthorizeErrorPage(parsed.error));
      }
      return;
    }
    const v = parsed.value;
    const fields: ConsentFields = {
      client_id: v.client.client_id,
      redirect_uri: v.redirect_uri,
      scope: v.scope.join(' '),
      state: v.state,
      code_challenge: v.code_challenge,
      code_challenge_method: 'S256',
      resource: v.resource,
    };
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(
        renderConsentPage({
          fields,
          clientName: v.client.client_name || v.client.client_id,
          scopes: v.scope,
          publicUrlWarning: deps.publicUrlWarning,
        })
      );
  };
}

// ---------------------------------------------------------------------------
// POST /authorize — owner passphrase gate + approve/deny
// ---------------------------------------------------------------------------

function authorizePostHandler(deps: OAuthRouterDeps): RequestHandler {
  return async (req, res) => {
    const base = publicBaseForRequest(req, deps.publicUrl);
    const body = (req.body ?? {}) as Record<string, string>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const queryLike: Record<string, unknown> = {
      client_id: str(body.client_id),
      redirect_uri: str(body.redirect_uri),
      response_type: 'code',
      scope: str(body.scope),
      state: str(body.state),
      code_challenge: str(body.code_challenge),
      code_challenge_method: str(body.code_challenge_method) || 'S256',
      resource: str(body.resource),
    };
    const rerender = (error: string, fallback: AuthorizeRequest | null) => {
      if (!fallback) {
        res.status(400).send(renderAuthorizeErrorPage(error));
        return;
      }
      res
        .status(403)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(
          renderConsentPage({
            fields: {
              client_id: fallback.client.client_id,
              redirect_uri: fallback.redirect_uri,
              scope: fallback.scope.join(' '),
              state: fallback.state,
              code_challenge: fallback.code_challenge,
              code_challenge_method: 'S256',
              resource: fallback.resource,
            },
            clientName: fallback.client.client_name || fallback.client.client_id,
            scopes: fallback.scope,
            publicUrlWarning: deps.publicUrlWarning,
            error,
          })
        );
    };

    // Re-validate everything from the hidden fields (never trust the form).
    const parsed = await parseAuthorizeRequest(deps.store, queryLike, base);
    if (!parsed.ok) {
      if (parsed.redirectable) {
        redirectWithError(res, parsed.redirect_uri, parsed.error, parsed.state, parsed.description);
      } else {
        res.status(400).send(renderAuthorizeErrorPage(parsed.error));
      }
      return;
    }
    const v = parsed.value;

    if (str(body.action) === 'deny') {
      redirectWithError(res, v.redirect_uri, 'access_denied', v.state, 'The owner denied the request');
      return;
    }
    if (str(body.action) !== 'approve') {
      rerender('Unknown action.', v);
      return;
    }
    if (!deps.secretsEqual(str(body.passphrase || ''), deps.ownerSecret)) {
      rerender('Wrong owner passphrase. No code was issued.', v);
      return;
    }
    const code = await deps.store.issueCode({
      client_id: v.client.client_id,
      redirect_uri: v.redirect_uri,
      scope: v.scope,
      code_challenge: v.code_challenge,
      resource: v.resource,
    });
    const u = new URL(v.redirect_uri);
    u.searchParams.set('code', code);
    if (v.state) u.searchParams.set('state', v.state);
    res.redirect(302, u.toString());
  };
}

// ---------------------------------------------------------------------------
// POST /token — authorization_code + refresh_token grants
// ---------------------------------------------------------------------------

function pkceValid(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return digest.length === challenge.length && digest === challenge;
}

function tokenHandler(deps: OAuthRouterDeps): RequestHandler {
  return async (req, res) => {
    const base = publicBaseForRequest(req, deps.publicUrl);
    const resource = protectedResourceUrl(base);
    const body = (req.body ?? {}) as Record<string, string>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const grantType = str(body.grant_type);

    if (grantType === 'authorization_code') {
      const code = str(body.code);
      const redirect_uri = str(body.redirect_uri);
      const verifier = str(body.code_verifier);
      const client_id = str(body.client_id);
      if (!code || !redirect_uri || !verifier || !client_id) {
        oauthError(res, 400, 'invalid_request', 'code, redirect_uri, code_verifier and client_id are required');
        return;
      }
      const record = await deps.store.consumeCode(code);
      if (!record) {
        oauthError(res, 400, 'invalid_grant', 'authorization code is invalid, expired, or already used');
        return;
      }
      if (record.client_id !== client_id) {
        oauthError(res, 400, 'invalid_grant', 'code was not issued to this client');
        return;
      }
      if (record.redirect_uri !== redirect_uri) {
        oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
        return;
      }
      if (record.resource !== resource) {
        oauthError(res, 400, 'invalid_grant', 'code was issued for a different resource');
        return;
      }
      if (!pkceValid(verifier, record.code_challenge)) {
        oauthError(res, 400, 'invalid_grant', 'PKCE code_verifier does not match the challenge');
        return;
      }
      const family = newId('fam');
      const accessToken = await deps.store.issueAccessToken({
        client_id,
        scope: record.scope,
        resource,
        family,
      });
      const out: Record<string, unknown> = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: record.scope.join(' '),
      };
      if (record.scope.includes('offline_access')) {
        const { token: refreshToken } = await deps.store.issueRefreshToken({
          client_id,
          scope: record.scope,
          resource,
          family,
        });
        out.refresh_token = refreshToken;
      }
      res.json(out);
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = str(body.refresh_token);
      if (!refreshToken) {
        oauthError(res, 400, 'invalid_request', 'refresh_token is required');
        return;
      }
      const rotated = await deps.store.rotateRefresh(refreshToken);
      if (!rotated.ok) {
        const descriptions: Record<string, string> = {
          not_found: 'refresh token is unknown',
          expired: 'refresh token has expired — sign in again',
          revoked: 'refresh token was revoked — sign in again',
          replayed: 'refresh token reuse detected — the token family was revoked, sign in again',
        };
        oauthError(res, 400, 'invalid_grant', descriptions[rotated.reason]);
        return;
      }
      const record = await deps.store.getToken(rotated.refreshToken);
      res.json({
        access_token: rotated.accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: (record?.scope ?? []).join(' '),
        refresh_token: rotated.refreshToken,
      });
      return;
    }

    oauthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  };
}

// ---------------------------------------------------------------------------
// POST /revoke — RFC 7009 (always 200)
// ---------------------------------------------------------------------------

function revokeHandler(deps: OAuthRouterDeps): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const token = typeof body.token === 'string' ? body.token : '';
    if (token) {
      // Revoking a refresh token revokes its whole family (incl. access tokens).
      await deps.store.revokeTokenValue(token);
    }
    res.status(200).json({});
  };
}

export function createOAuthRouter(deps: OAuthRouterDeps): Router {
  const router = express.Router();
  router.use(metadataRouter(deps));
  router.post('/register', express.json({ limit: '64kb' }), registerHandler(deps));
  router.get('/authorize', authorizeGetHandler(deps));
  router.post('/authorize', express.urlencoded({ extended: false }), authorizePostHandler(deps));
  router.post('/token', express.urlencoded({ extended: false }), tokenHandler(deps));
  router.post('/revoke', express.urlencoded({ extended: false }), revokeHandler(deps));
  return router;
}
