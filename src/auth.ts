/**
 * Auth for the /mcp endpoint: two accepted credential shapes, one middleware.
 *
 * 1. Static bearer token (PREMIERE_MCP_TOKEN) — the single-user fallback.
 *    Verified in constant time; the resulting identity is `owner:bearer`
 *    with the `admin` scope (it predates OAuth and keeps full control).
 *
 * 2. OAuth 2.1 access tokens (opaque, self-issued by this server's /token).
 *    Looked up by SHA-256 hash in the token store; the identity becomes
 *    `oauth:<client_id>` with the scopes granted at consent time. Tokens are
 *    bound to this server's protected resource (<base>/mcp): a token issued
 *    for a different base URL is rejected even if its signature/hash matches.
 *
 * Unauthenticated /mcp requests get 401 + `WWW-Authenticate: Bearer
 * error="invalid_token", ..., resource_metadata="<base>/.well-known/oauth-protected-resource"`
 * (RFC 9728). That challenge is THE discovery trigger: without it,
 * ChatGPT/Claude connect anonymously and never offer sign-in. The metadata
 * URL is computed per request so the issuer matches the fetch origin behind
 * the Cloudflare tunnel.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { TokenStore } from './oauth/store.js';

/** Constant-time string compare to avoid leaking secret bytes via timing. */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export interface VerifierDeps {
  staticToken: string;
  store: TokenStore;
}

/**
 * Build the SDK verifier from the static token + the OAuth token store.
 * Exported for unit tests.
 *
 * The returned AuthInfo carries a non-standard `resource` field (the
 * protected resource the token was issued for); the middleware below checks
 * it against the current request's resource.
 */
export function buildVerifier(deps: VerifierDeps): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (tokensEqual(token, deps.staticToken)) {
        return {
          token,
          clientId: 'owner:bearer',
          scopes: ['admin'],
          // Static token: effectively long-lived. Rotate it via the installer.
          expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        };
      }
      const record = await deps.store.getToken(token);
      if (
        !record ||
        record.kind !== 'access' ||
        record.status !== 'active' ||
        record.expires_at <= Date.now()
      ) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
      }
      return {
        token,
        clientId: `oauth:${record.client_id}`,
        scopes: record.scope,
        expiresAt: Math.floor(record.expires_at / 1000),
        resource: record.resource,
      } as AuthInfo & { resource: string };
    },
  };
}

export interface McpAuthMiddlewareDeps {
  verifier: OAuthTokenVerifier;
  /** Per-request: <base>/.well-known/oauth-protected-resource */
  metadataUrlFor: (req: Request) => string;
  /** Per-request: <base>/mcp — tokens must be bound to it. */
  resourceFor: (req: Request) => string;
}

/**
 * Express middleware enforcing bearer auth on /mcp. On success sets
 * req.auth (surfaced to tool handlers as extra.http.authInfo); on failure
 * answers 401 with the RFC 9728 resource_metadata challenge.
 */
export function createMcpAuthMiddleware(deps: McpAuthMiddlewareDeps): RequestHandler {
  return async (req, res, next) => {
    const fail = (description: string): void => {
      const challenge =
        `Bearer error="invalid_token", ` +
        `error_description="${description}", ` +
        `resource_metadata="${deps.metadataUrlFor(req)}"`;
      res.set('WWW-Authenticate', challenge);
      res.status(401).json({ error: 'invalid_token', error_description: description });
    };

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      fail('Missing bearer token');
      return;
    }
    try {
      const auth = await deps.verifier.verifyAccessToken(token);
      const boundResource = (auth as AuthInfo & { resource?: string }).resource;
      if (boundResource && boundResource !== deps.resourceFor(req)) {
        fail('Token was not issued for this server');
        return;
      }
      (req as unknown as { auth: AuthInfo }).auth = auth;
      next();
    } catch (e) {
      if (e instanceof OAuthError) {
        fail(e.message || 'Invalid bearer token');
      } else {
        fail('Invalid bearer token');
      }
    }
  };
}
