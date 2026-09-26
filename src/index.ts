/**
 * premiere-mcp-server entry point.
 *
 * - Streamable-HTTP MCP endpoint at POST /mcp (SDK v2, era-aware: serves both
 *   2025-era and 2026-07-28-era clients from one factory).
 * - Bearer-token auth in front of /mcp (token from PREMIERE_MCP_TOKEN).
 * - /health is unauthenticated for the tunnel / process monitor.
 * - Binds 127.0.0.1 ONLY. Remote ingress is the Cloudflare Tunnel (or
 *   Tailscale serve) on the Windows PC — never port-forward this port.
 */
import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { AuditLog } from './audit.js';
import { buildVerifier } from './auth.js';
import { AeBridge } from './bridge/aeBridge.js';
import { FileQueueBridge, loadPrelude } from './bridge/fileQueue.js';
import { loadConfig } from './config.js';
import { buildServer, SERVER_VERSION } from './server.js';

const config = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const prelude = await loadPrelude(join(here, 'bridge', 'prelude.jsx.txt'));

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

// Default bind is loopback; the SDK arms Host/Origin validation for it
// (DNS-rebinding protection). cloudflared dials 127.0.0.1:PORT from the PC.
const app = createMcpExpressApp();

app.get('/health', (_req, res) => {
  res.json({ ok: true, server: 'premiere-mcp-server', version: SERVER_VERSION });
});

app.all(
  '/mcp',
  requireBearerAuth({ verifier: buildVerifier(config.token) }),
  (req, res) => void nodeHandler(req, res, req.body)
);

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[premiere-mcp-server] v${SERVER_VERSION} listening on 127.0.0.1:${config.port}`);
  console.log(`[premiere-mcp-server] bridge temp dir: ${config.premiereTempDir}`);
  console.log(`[premiere-mcp-server] assets dir: ${config.assetsDir}`);
});

process.on('SIGINT', () => void handler.close().finally(() => process.exit(0)));
process.on('SIGTERM', () => void handler.close().finally(() => process.exit(0)));
