/**
 * OAuth 2.1 token store: clients, authorization codes, and tokens persisted
 * as one JSON file in the server home dir.
 *
 * Security properties (borrowed pattern, not code, from amitray007/silo MIT):
 * - Secrets are never stored raw: every code/token value is SHA-256 hashed at
 *   rest; lookup hashes the presented value. A stolen oauth.json still does
 *   not yield usable tokens.
 * - Auth codes are single-use (atomic consume: read + delete in one tick) and
 *   short-lived (10 min).
 * - Refresh tokens rotate: each use invalidates the old token and issues a
 *   new one in the same family. Presenting an already-rotated token is a
 *   replay — the whole family is revoked.
 * - The JSON file is written with mode 0600 inside a 0700 directory.
 *
 * Node is single-threaded, so "atomic" here means no awaits between the
 * check and the mutation. All mutating methods save before returning.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10min

/** SHA-256 hex of a secret value. Exported so the auth layer hashes consistently. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** New opaque secret: 32 random bytes, base64url (no padding). */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** New public id (client ids, rotation families). */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export interface StoredClient {
  client_id: string;
  client_name?: string;
  /** Exact redirect URIs registered at DCR time (or from the CIMD doc). */
  redirect_uris: string[];
  /** Granted scopes (normalized: 'mcp' expanded, unknown dropped). */
  scope: string[];
  created_at: number;
  /** Set when the client came from a client_id metadata document URL. */
  cimd?: string;
}

export interface StoredCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scope: string[];
  code_challenge: string;
  code_challenge_method: 'S256';
  /** Protected resource this code is bound to (base URL + '/mcp'). */
  resource: string;
  expires_at: number;
  created_at: number;
}

export type TokenStatus = 'active' | 'rotated' | 'revoked';

export interface StoredToken {
  hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  scope: string[];
  resource: string;
  expires_at: number;
  created_at: number;
  /** Rotation family: all tokens descended from one authorization share it. */
  family: string;
  status: TokenStatus;
  /** Hash of the refresh token that replaced this one (when rotated). */
  replaced_by?: string;
}

interface StoreFile {
  clients: Record<string, StoredClient>;
  codes: Record<string, StoredCode>;
  tokens: Record<string, StoredToken>;
}

function emptyStore(): StoreFile {
  return { clients: {}, codes: {}, tokens: {} };
}

export class TokenStore {
  private file: string | null;
  private data: StoreFile = emptyStore();
  private loaded = false;

  /**
   * @param file Full path of oauth.json, or null for an ephemeral in-memory
   *   store (used by tests). When a file is given the parent dir is created
   *   0700 and the file written 0600.
   */
  constructor(file: string | null) {
    this.file = file;
  }

  static oauthFileFor(homeDir: string): string {
    return join(homeDir, 'oauth.json');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      this.data = {
        clients: parsed.clients ?? {},
        codes: parsed.codes ?? {},
        tokens: parsed.tokens ?? {},
      };
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== 'ENOENT') {
        console.error('[oauth] could not parse store, starting empty:', e);
      }
      this.data = emptyStore();
    }
  }

  private async save(): Promise<void> {
    this.prune();
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  /** Drop expired codes/tokens (rotated refresh records are kept until they expire, for replay detection). */
  private prune(): void {
    const now = Date.now();
    for (const [h, c] of Object.entries(this.data.codes)) {
      if (c.expires_at <= now) delete this.data.codes[h];
    }
    for (const [h, t] of Object.entries(this.data.tokens)) {
      if (t.expires_at <= now) delete this.data.tokens[h];
    }
  }

  // ---------- clients ----------

  async registerClient(client: Omit<StoredClient, 'created_at'>): Promise<StoredClient> {
    await this.ensureLoaded();
    const record: StoredClient = { ...client, created_at: Date.now() };
    this.data.clients[client.client_id] = record;
    await this.save();
    return record;
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    await this.ensureLoaded();
    return this.data.clients[clientId] ?? null;
  }

  // ---------- authorization codes ----------

  async issueCode(args: {
    client_id: string;
    redirect_uri: string;
    scope: string[];
    code_challenge: string;
    resource: string;
    ttlMs?: number;
  }): Promise<string> {
    await this.ensureLoaded();
    const code = newSecret();
    const now = Date.now();
    const record: StoredCode = {
      code_hash: sha256Hex(code),
      client_id: args.client_id,
      redirect_uri: args.redirect_uri,
      scope: args.scope,
      code_challenge: args.code_challenge,
      code_challenge_method: 'S256',
      resource: args.resource,
      created_at: now,
      expires_at: now + (args.ttlMs ?? AUTH_CODE_TTL_MS),
    };
    this.data.codes[record.code_hash] = record;
    await this.save();
    return code;
  }

  /**
   * Atomically consume an authorization code: returns the record and deletes
   * it, or null when unknown/expired. A second use of the same code fails.
   */
  async consumeCode(code: string): Promise<StoredCode | null> {
    await this.ensureLoaded();
    const hash = sha256Hex(code);
    const record = this.data.codes[hash];
    if (!record) return null;
    delete this.data.codes[hash];
    await this.save();
    if (record.expires_at <= Date.now()) return null;
    return record;
  }

  // ---------- tokens ----------

  async issueAccessToken(args: {
    client_id: string;
    scope: string[];
    resource: string;
    family: string;
    ttlMs?: number;
  }): Promise<string> {
    await this.ensureLoaded();
    const token = newSecret();
    const now = Date.now();
    const ttl = args.ttlMs ?? ACCESS_TOKEN_TTL_MS;
    this.data.tokens[sha256Hex(token)] = {
      hash: sha256Hex(token),
      kind: 'access',
      client_id: args.client_id,
      scope: args.scope,
      resource: args.resource,
      created_at: now,
      expires_at: now + ttl,
      family: args.family,
      status: 'active',
    };
    await this.save();
    return token;
  }

  async issueRefreshToken(args: {
    client_id: string;
    scope: string[];
    resource: string;
    family?: string;
    ttlMs?: number;
  }): Promise<{ token: string; family: string }> {
    await this.ensureLoaded();
    const token = newSecret();
    const now = Date.now();
    const ttl = args.ttlMs ?? REFRESH_TOKEN_TTL_MS;
    const family = args.family ?? newId('fam');
    this.data.tokens[sha256Hex(token)] = {
      hash: sha256Hex(token),
      kind: 'refresh',
      client_id: args.client_id,
      scope: args.scope,
      resource: args.resource,
      created_at: now,
      expires_at: now + ttl,
      family,
      status: 'active',
    };
    await this.save();
    return { token, family };
  }

  /** Look up any token (access or refresh) by its presented value. */
  async getToken(token: string): Promise<StoredToken | null> {
    await this.ensureLoaded();
    return this.data.tokens[sha256Hex(token)] ?? null;
  }

  /**
   * Rotate a refresh token: marks the old one rotated and issues a fresh
   * access + refresh pair in the same family. If the presented token was
   * already rotated (replay), the entire family is revoked.
   */
  async rotateRefresh(
    token: string
  ): Promise<
    | { ok: true; accessToken: string; refreshToken: string }
    | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'replayed' }
  > {
    await this.ensureLoaded();
    const hash = sha256Hex(token);
    const record = this.data.tokens[hash];
    if (!record || record.kind !== 'refresh') return { ok: false, reason: 'not_found' };
    if (record.status === 'rotated') {
      // Replay of an old refresh token: compromise suspected — kill the family.
      await this.revokeFamily(record.family);
      return { ok: false, reason: 'replayed' };
    }
    if (record.status === 'revoked') return { ok: false, reason: 'revoked' };
    if (record.expires_at <= Date.now()) return { ok: false, reason: 'expired' };

    const accessToken = await this.issueAccessToken({
      client_id: record.client_id,
      scope: record.scope,
      resource: record.resource,
      family: record.family,
    });
    const { token: refreshToken } = await this.issueRefreshToken({
      client_id: record.client_id,
      scope: record.scope,
      resource: record.resource,
      family: record.family,
    });
    record.status = 'rotated';
    record.replaced_by = sha256Hex(refreshToken);
    await this.save();
    return { ok: true, accessToken, refreshToken };
  }

  /** Revoke one token by value; revoking a refresh token revokes its family. */
  async revokeTokenValue(token: string): Promise<boolean> {
    await this.ensureLoaded();
    const record = this.data.tokens[sha256Hex(token)];
    if (!record) return false;
    if (record.kind === 'refresh') {
      await this.revokeFamily(record.family);
    } else {
      record.status = 'revoked';
      await this.save();
    }
    return true;
  }

  async revokeFamily(family: string): Promise<void> {
    await this.ensureLoaded();
    for (const t of Object.values(this.data.tokens)) {
      if (t.family === family && t.status === 'active') t.status = 'revoked';
    }
    await this.save();
  }

  /** Test helper: number of stored records. */
  async counts(): Promise<{ clients: number; codes: number; tokens: number }> {
    await this.ensureLoaded();
    return {
      clients: Object.keys(this.data.clients).length,
      codes: Object.keys(this.data.codes).length,
      tokens: Object.keys(this.data.tokens).length,
    };
  }
}
