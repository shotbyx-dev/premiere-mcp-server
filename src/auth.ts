/**
 * Bearer-token auth for the /mcp endpoint.
 *
 * Today: a single pre-shared token (PREMIERE_MCP_TOKEN), compared in
 * constant time. This is the pragmatic single-user story behind a private
 * tunnel or Tailscale.
 *
 * FUTURE SEAM (OAuth 2.1 + DCR): the @modelcontextprotocol/express
 * `requireBearerAuth` middleware already answers 401 with a
 * `WWW-Authenticate: Bearer ... resource_metadata="..."` challenge (RFC 9728).
 * To upgrade: implement a real OAuthTokenVerifier (JWT introspection), mount
 * `mcpAuthMetadataRouter` to serve /.well-known/oauth-protected-resource/mcp,
 * and point ChatGPT/Muse at the metadata URL. No tool code changes needed —
 * auth stays entirely in the HTTP layer.
 */
import { timingSafeEqual } from 'node:crypto';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';

/** Constant-time string compare to avoid leaking token bytes via timing. */
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

/** Build the SDK verifier from the configured token. Exported for unit tests. */
export function buildVerifier(expectedToken: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!tokensEqual(token, expectedToken)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid bearer token');
      }
      return {
        token,
        clientId: 'premiere-mcp-client',
        scopes: ['mcp'],
        // Static token: effectively long-lived. Real OAuth would use the JWT exp.
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      };
    },
  };
}
