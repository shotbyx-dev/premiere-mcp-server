/**
 * Redirect-URI policy, enforced at BOTH /register (DCR) and /authorize.
 *
 * Exactly three shapes are allowed — everything else is rejected, so a
 * malicious client can never register an open redirect that leaks
 * authorization codes:
 *
 * (a) Claude connectors: exact
 *     https://claude.ai/api/mcp/auth_callback
 *     https://claude.com/api/mcp/auth_callback
 * (b) ChatGPT connectors: https://chatgpt.com/connector/oauth/... (prefix,
 *     host pinned to chatgpt.com — URL parsing defeats userinfo/subdomain
 *     tricks like https://chatgpt.com@evil.com/)
 * (c) RFC 8252 loopback for native apps: http://127.0.0.1:<any-port>/callback
 *     (also ::1 / localhost), port-agnostic per the RFC
 */
import type { StoredClient } from './store.js';

const CLAUDE_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function validateRedirectUri(
  uri: string
): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.hash) return { ok: false, reason: 'must not contain a fragment' };
  if (u.username || u.password) return { ok: false, reason: 'must not contain userinfo' };

  // (a) Claude exact callbacks
  if (CLAUDE_CALLBACKS.has(uri)) return { ok: true };

  // (b) ChatGPT connector callbacks — host pinned, path prefix checked.
  if (
    u.protocol === 'https:' &&
    u.hostname.toLowerCase() === 'chatgpt.com' &&
    (u.pathname === '/connector/oauth' || u.pathname.startsWith('/connector/oauth/'))
  ) {
    return { ok: true };
  }

  // (c) RFC 8252 loopback, port-agnostic.
  if (
    u.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) &&
    u.pathname === '/callback'
  ) {
    return { ok: true };
  }

  return { ok: false, reason: 'not an allowed callback URL' };
}

/**
 * The redirect_uri presented at /authorize must be one of the client's
 * registered URIs (exact string match) AND pass the policy (defense in
 * depth — a stored value from before a policy tightening still gets checked).
 */
export function authorizeRedirectAllowed(
  client: StoredClient,
  redirectUri: string
): { ok: true } | { ok: false; reason: string } {
  if (!client.redirect_uris.includes(redirectUri)) {
    return { ok: false, reason: 'redirect_uri is not registered for this client' };
  }
  return validateRedirectUri(redirectUri);
}
