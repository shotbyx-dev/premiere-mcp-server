/**
 * MCP server factory: registers all tool families on a fresh McpServer.
 * A new server is built per HTTP request (SDK v2 stateless model); heavy
 * state (bridges, audit log) is created once in index.ts and closed over.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AuditLog, summarizeArgs } from './audit.js';
import { AeBridge } from './bridge/aeBridge.js';
import { FileQueueBridge } from './bridge/fileQueue.js';
import type { ServerConfig } from './config.js';
import {
  requiredScopeForTool,
  satisfiesScope,
  type ToolScope,
} from './oauth/scopes.js';
import { buildAeTools } from './tools/aftereffects.js';
import { buildPremiereTools, type ToolContext, type ToolDef } from './tools/premiere.js';

export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  config: ServerConfig;
  premiereBridge: FileQueueBridge;
  aeBridge: AeBridge | null;
  audit: AuditLog;
}

/**
 * Scope gate for one tool call. Exported for unit tests.
 * `authInfo` is the verified identity from the HTTP layer (undefined only
 * when a transport does not carry auth, e.g. stdio — treated as no scopes).
 */
export function checkToolScope(
  authInfo: Pick<AuthInfo, 'scopes'> | undefined,
  tool: ToolDef
): { ok: true } | { ok: false; required: ToolScope } {
  const required = requiredScopeForTool(tool);
  return satisfiesScope(authInfo?.scopes, required)
    ? { ok: true }
    : { ok: false, required };
}

function registerToolFamily(
  server: McpServer,
  tools: ToolDef[],
  baseCtx: Record<string, unknown>,
  audit: AuditLog
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown, extra: unknown) => {
        const authInfo = (
          extra as { http?: { authInfo?: AuthInfo } }
        )?.http?.authInfo;
        const caller = authInfo?.clientId ?? 'unknown';
        // OAuth scope gate: read/write/admin per tool (static bearer is
        // admin-scoped; OAuth tokens carry their granted scopes).
        const scopeCheck = checkToolScope(authInfo, tool);
        if (!scopeCheck.ok) {
          await audit.record({
            caller,
            tool: tool.name,
            argsSummary: summarizeArgs(args),
            outcome: 'error',
            detail: `insufficient_scope: requires '${scopeCheck.required}'`,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Error in ${tool.name}: insufficient_scope — this tool requires ` +
                  `the '${scopeCheck.required}' scope. Reconnect and approve it on the consent page.`,
              },
            ],
            isError: true,
          };
        }
        const ctx = { ...baseCtx, caller } as ToolContext;
        try {
          const result = await tool.run(args, ctx);
          await audit.record({
            caller,
            tool: tool.name,
            argsSummary: summarizeArgs(args),
            outcome: 'ok',
          });
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await audit.record({
            caller,
            tool: tool.name,
            argsSummary: summarizeArgs(args),
            outcome: 'error',
            detail: message,
          });
          return {
            content: [{ type: 'text' as const, text: `Error in ${tool.name}: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }
}

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'premiere-mcp-server', version: SERVER_VERSION });

  registerToolFamily(
    server,
    buildPremiereTools(),
    { bridge: deps.premiereBridge, assetsDir: deps.config.assetsDir },
    deps.audit
  );

  if (deps.aeBridge) {
    registerToolFamily(
      server,
      buildAeTools(),
      { ae: deps.aeBridge, assetsDir: deps.config.assetsDir },
      deps.audit
    );
  }

  // Catalog escape hatch (searches the combined Premiere + AE registry).
  registerToolFamily(server, [buildSearchTool()], {}, deps.audit);

  return server;
}

/** Flat registry used by unit tests to validate every tool definition. */
export function toolRegistry(): ToolDef[] {
  return [...buildPremiereTools(), ...buildAeTools(), buildSearchTool()];
}

const SEARCH_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Escape-hatch catalog search: lets an agent find the right tool by keyword. */
export function buildSearchTool(): ToolDef {
  return {
    name: 'search_tools',
    title: 'Search available tools',
    description:
      'Full-text search over this server\'s tool catalog (Premiere Pro + After Effects). ' +
      'Use it to discover which tool fits a task before guessing.',
    inputSchema: z.object({
      query: z.string().describe('Keyword to search tool names/titles/descriptions; empty returns all'),
    }),
    annotations: SEARCH_ANNOTATIONS,
    run: async (args: any) => {
      const q = String(args.query ?? '').toLowerCase().trim();
      const hits = toolRegistry()
        .filter((t) => !q || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(q))
        .slice(0, 25)
        .map((t) => ({ name: t.name, title: t.title, description: t.description }));
      return { query: args.query ?? '', count: hits.length, tools: hits };
    },
  };
}
