/**
 * Central configuration, all from environment (never hardcode secrets).
 *
 * Required:
 *   PREMIERE_MCP_TOKEN   Bearer token clients must send as `Authorization: Bearer <token>`
 *
 * Optional:
 *   PORT                 HTTP listen port (default 8787). Bound to 127.0.0.1 only;
 *                        the Cloudflare Tunnel is the only ingress.
 *   GEMINI_API_KEY       (removed — no paid video APIs; the assistant generates
 *                        video itself via media.generate_video and the server
 *                        imports it with import_media_from_url)
 *   PREMIERE_MCP_ASSETS  Where fetched/generated clips are saved.
 *                        Default: C:\Shotbyx\AI_Clips on Windows, ~/.premiere-mcp-server/assets elsewhere.
 *   PREMIERE_TEMP_DIR    Shared bridge dir with the CEP panel(s).
 *                        Default: %TEMP%\premiere-mcp-bridge on Windows.
 *                        MUST match the panel's "Temp Directory" setting.
 *   AE_TEMP_DIR          Bridge dir shared with the AE "MCP Bridge Auto" panel.
 *                        Default: %USERPROFILE%\Documents\ae-mcp-bridge (must match
 *                        the panel, which hardcodes this path).
 *   PREMIERE_MCP_AUDIT   Audit log path (default <assets-dir>/../audit.jsonl).
 *   PREMIERE_MCP_HOME    Server home dir for OAuth state (clients, tokens,
 *                        owner secret). Default: %APPDATA%\PremierePilot on
 *                        Windows, ~/.premiere-mcp-server elsewhere.
 *   PREMIERE_MCP_PUBLIC_URL
 *                        Public base URL of this server, e.g.
 *                        https://mcp.example.com — the Cloudflare Tunnel
 *                        hostname. Used as the OAuth issuer and for the
 *                        WWW-Authenticate resource_metadata discovery URL.
 *                        Also allow-lists the public Host header through the
 *                        SDK's DNS-rebinding guard (required: without it the
 *                        tunnel's public Host is rejected with 403).
 *   PREMIERE_MCP_OWNER_SECRET
 *                        Passphrase protecting the OAuth consent page. If
 *                        unset, one is generated on first start, stored in
 *                        the server home dir (0600), and printed to the
 *                        console once.
 */
import os from 'node:os';
import path from 'node:path';

function defaultAssetsDir(): string {
  if (process.platform === 'win32') return 'C:\\Shotbyx\\AI_Clips';
  return path.join(os.homedir(), '.premiere-mcp-server', 'assets');
}

function defaultTempDir(): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(base, 'premiere-mcp-bridge');
}

function defaultHomeDir(): string {
  // Server home for OAuth state (clients, tokens, owner secret). Kept out of
  // the assets dir on purpose: assets may be shared/synced, this must not be.
  if (process.platform === 'win32') {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'PremierePilot');
  }
  return path.join(os.homedir(), '.premiere-mcp-server');
}

function defaultAeTempDir(): string {  // Must match the MCP Bridge Auto panel (mcp-bridge-auto.jsx), which hardcodes
  // %USERPROFILE%\Documents\ae-mcp-bridge. Override AE_TEMP_DIR only if you also
  // edit the panel's getCommandFilePath()/getResultFilePath().
  const home = process.env.USERPROFILE || process.env.HOME || os.tmpdir();
  return path.join(home, 'Documents', 'ae-mcp-bridge');
}

export interface ServerConfig {
  token: string;
  port: number;
  assetsDir: string;
  premiereTempDir: string;
  aeTempDir: string;
  auditPath: string;
  /** Server home dir (OAuth state). PREMIERE_MCP_HOME or platform default. */
  homeDir: string;
  /** Public base URL, e.g. https://mcp.example.com (PREMIERE_MCP_PUBLIC_URL). */
  publicUrl: string | null;
  /** Raw PREMIERE_MCP_OWNER_SECRET env (resolved to a persisted secret at startup). */
  ownerSecretEnv: string | null;
}

export function loadConfig(): ServerConfig {
  const token = process.env.PREMIERE_MCP_TOKEN;
  if (!token || token.trim().length < 16) {
    throw new Error(
      'PREMIERE_MCP_TOKEN is missing or too short (min 16 chars). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const assetsDir = process.env.PREMIERE_MCP_ASSETS || defaultAssetsDir();
  const publicUrl = (process.env.PREMIERE_MCP_PUBLIC_URL || '').trim() || null;
  if (publicUrl) {
    let u: URL;
    try {
      u = new URL(publicUrl);
    } catch {
      throw new Error('PREMIERE_MCP_PUBLIC_URL is not a valid URL: ' + publicUrl);
    }
    if (u.protocol !== 'https:') {
      throw new Error('PREMIERE_MCP_PUBLIC_URL must be https (the tunnel URL): ' + publicUrl);
    }
  }
  return {
    token: token.trim(),
    port: Number(process.env.PORT || 8787),
    assetsDir,
    premiereTempDir: process.env.PREMIERE_TEMP_DIR || defaultTempDir(),
    aeTempDir: process.env.AE_TEMP_DIR || defaultAeTempDir(),
    auditPath:
      process.env.PREMIERE_MCP_AUDIT || path.join(path.dirname(assetsDir), 'audit.jsonl'),
    homeDir: process.env.PREMIERE_MCP_HOME?.trim() || defaultHomeDir(),
    publicUrl,
    ownerSecretEnv: (process.env.PREMIERE_MCP_OWNER_SECRET || '').trim() || null,
  };
}
