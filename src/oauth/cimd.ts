/**
 * Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document).
 *
 * When a client_id is an https URL and our AS metadata advertises
 * client_id_metadata_document_supported, the client never calls /register:
 * we fetch its metadata doc, validate every redirect_uri against the policy,
 * and treat the doc as its registration. Docs are cached in memory for 1h.
 *
 * This is ChatGPT's preferred path; DCR (/register) covers everyone else.
 */
import { validateRedirectUri } from './redirects.js';

export interface ClientMetadataDocument {
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; doc: ClientMetadataDocument }>();

/** Test hook: clear the in-memory doc cache. */
export function clearCimdCache(): void {
  cache.clear();
}

export async function fetchClientMetadataDocument(
  url: string
): Promise<ClientMetadataDocument | null> {
  if (!/^https:\/\/[^/]+/.test(url)) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.doc;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) return null;
    const redirect_uris = body.redirect_uris.filter(
      (u): u is string => typeof u === 'string'
    );
    if (redirect_uris.length === 0) return null;
    // Every redirect URI in the doc must pass the policy — no open redirects.
    if (!redirect_uris.every((u) => validateRedirectUri(u).ok)) return null;
    const doc: ClientMetadataDocument = {
      redirect_uris,
      client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
    };
    cache.set(url, { at: Date.now(), doc });
    return doc;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
