/**
 * premiere-mcp-server entry point.
 *
 * - Streamable-HTTP MCP endpoint at POST /mcp (SDK v2, era-aware: serves both
 *   2025-era and 2026-07-28-era clients from one factory).
 * - Auth in front of /mcp: static bearer token (PREMIERE_MCP_TOKEN,
 *   single-user fallback, admin-scoped) or OAuth 2.1 access tokens issued by
 *   the co-hosted authorization server. Unauthenticated requests get
 *   401 + WWW-Authenticate with resource_metadata for client discovery.
 * - OAuth 2.1 + DCR endpoints: /.well-known/*, /register, /authorize,
 *   /token, /revoke (see src/oauth/).
 * - /health is unauthenticated for the tunnel / process monitor.
 * - Binds 127.0.0.1 ONLY. Remote ingress is the Cloudflare Tunnel (or
 *   Tailscale serve) on the Windows PC — never port-forward this port.
 *
 * Host validation: the SDK's createMcpExpressApp applies a DNS-rebinding
 * guard. When PREMIERE_MCP_PUBLIC_URL is set, the public tunnel hostname is
 * allow-listed alongside loopback — without this, every request arriving via
 * the tunnel is rejected with 403 (cloudflared preserves the public Host).
 */
import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { AuditLog } from './audit.js';
import { buildVerifier, createMcpAuthMiddleware, tokensEqual } from './auth.js';
import { AeBridge } from './bridge/aeBridge.js';
import { FileQueueBridge, loadPrelude } from './bridge/fileQueue.js';
import { loadConfig } from './config.js';
import { createOAuthRouter, publicBaseForRequest } from './oauth/router.js';
import { ensureOwnerSecret } from './oauth/owner.js';
import { TokenStore } from './oauth/store.js';
import { buildServer, SERVER_VERSION } from './server.js';

const config = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const prelude = await loadPrelude(join(here, 'bridge', 'prelude.jsx.txt'));

// OAuth state: token store + owner passphrase live in the server home dir.
const tokenStore = new TokenStore(TokenStore.oauthFileFor(config.homeDir));
const { secret: ownerSecret, generated: ownerSecretGenerated } = await ensureOwnerSecret(
  config.homeDir,
  config.ownerSecretEnv
);
if (ownerSecretGenerated) {
  console.log('');
  console.log('[premiere-mcp-server] Generated a new owner passphrase for the OAuth consent page:');
  console.log(`[premiere-mcp-server]   ${ownerSecret}`);
  console.log('[premiere-mcp-server] It is stored (0600) at ' + join(config.homeDir, 'owner-secret'));
  console.log('[premiere-mcp-server] Set PREMIERE_MCP_OWNER_SECRET to use your own instead.');
  console.log('');
}

const premiereBridge = new FileQueueBridge(
  {
    appName: 'Premiere Pro',
    tempDir: config.premiereTempDir,
    heartbeatFile: 'bridge-heartbeat.json',
    windowsProcessName: 'Adobe Premiere Pro.exe',
    windowsInstallRoot: 'Adobe',
    installFolderPrefix: 'Adobe Premiere Pro',
    windowsExeName: 'Adobe Premiere Pro.exe',
  },
  prelude
);

const audit = new AuditLog(config.auditPath);
await audit.record({
  caller: 'system',
  tool: 'server_start',
  argsSummary: { port: config.port, assetsDir: config.assetsDir, aeBridgeDir: config.aeTempDir },
  outcome: 'ok',
});

// After Effects bridge is always wired: the tools probe for a live panel at
// call time and return a clear error if AE isn't running.
const aeBridge = new AeBridge({ bridgeDir: config.aeTempDir });

const handler = createMcpHandler(() =>
  buildServer({ config, premiereBridge, aeBridge, audit })
);
const nodeHandler = toNodeHandler(handler);

const baseFor = (req: Request): string => publicBaseForRequest(req, config.publicUrl);

// Allow-list the tunnel's public hostname through the SDK's Host guard;
// without this, requests arriving via the tunnel are 403'd.
const publicHost = config.publicUrl ? new URL(config.publicUrl).hostname : null;
const app = createMcpExpressApp(
  publicHost
    ? {
        allowedHosts: ['localhost', '127.0.0.1', '[::1]', publicHost],
        allowedOrigins: ['localhost', '127.0.0.1', '[::1]', publicHost],
      }
    : {}
);

app.get('/health', (_req, res) => {
  res.json({ ok: true, server: 'premiere-mcp-server', version: SERVER_VERSION });
});

// OAuth 2.1 authorization server (DCR, authorize, token, revoke + discovery).
app.use(
  createOAuthRouter({
    store: tokenStore,
    ownerSecret,
    publicUrl: config.publicUrl,
    publicUrlWarning: config.publicUrl === null,
    secretsEqual: tokensEqual,
  })
);

app.all(
  '/mcp',
  createMcpAuthMiddleware({
    verifier: buildVerifier({ staticToken: config.token, store: tokenStore }),
    metadataUrlFor: (req) => `${baseFor(req)}/.well-known/oauth-protected-resource`,
    resourceFor: (req) => `${baseFor(req)}/mcp`,
  }),
  (req, res) => void nodeHandler(req, res, req.body)
);

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[premiere-mcp-server] v${SERVER_VERSION} listening on 127.0.0.1:${config.port}`);
  console.log(`[premiere-mcp-server] bridge temp dir: ${config.premiereTempDir}`);
  console.log(`[premiere-mcp-server] assets dir: ${config.assetsDir}`);
  console.log(`[premiere-mcp-server] server home: ${config.homeDir}`);
  if (config.publicUrl) {
    console.log(`[premiere-mcp-server] public URL: ${config.publicUrl}`);
  } else {
    console.log('[premiere-mcp-server] PREMIERE_MCP_PUBLIC_URL not set — OAuth metadata derives the issuer from the request host');
  }
});

process.on('SIGINT', () => void handler.close().finally(() => process.exit(0)));
process.on('SIGTERM', () => void handler.close().finally(() => process.exit(0)));
