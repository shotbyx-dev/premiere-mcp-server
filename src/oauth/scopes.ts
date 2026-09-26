/**
 * OAuth scope model.
 *
 * - `read`:  read-only tools (project info, clip properties, catalog search)
 * - `write`: non-destructive edits (timeline edits, imports, effects, exports)
 * - `admin`: destructive tools + raw ExtendScript execution
 * - `offline_access`: not a tool scope — permission to issue refresh tokens
 * - `mcp` (legacy, requested by ChatGPT by default): treated as read+write,
 *   never admin
 *
 * Every tool gets a required scope derived from its MCP annotations
 * (destructiveHint -> admin, readOnlyHint -> read, else write), with an
 * explicit override for `execute_extendscript` (admin, always).
 */
import type { ToolAnnotations } from '../tools/premiere.js';

export type ToolScope = 'read' | 'write' | 'admin';

/** All scopes the authorization server advertises (RFC 8414 scopes_supported). */
export const SCOPES_SUPPORTED = ['read', 'write', 'admin', 'offline_access'] as const;

const KNOWN = new Set<string>(SCOPES_SUPPORTED);

/**
 * Normalize a scope request (space-separated string or array) into the
 * granted set: expands legacy `mcp` to read+write, drops unknown scopes,
 * defaults to read-only when nothing usable was requested.
 */
export function normalizeScopes(requested: string | string[] | undefined): string[] {
  const parts = Array.isArray(requested)
    ? requested
    : String(requested ?? '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
  const out = new Set<string>();
  for (const s of parts) {
    if (s === 'mcp') {
      out.add('read');
      out.add('write');
    } else if (KNOWN.has(s)) {
      out.add(s);
    }
    // unknown scopes are dropped, never granted
  }
  if (out.size === 0) out.add('read');
  return [...out];
}

/** Does a granted scope set satisfy a tool's required scope? */
export function satisfiesScope(granted: string[] | undefined, required: ToolScope): boolean {
  const g = granted ?? [];
  if (g.includes('admin')) return true;
  if (g.includes(required)) return true;
  // Scope hierarchy: write implies read.
  if (required === 'read' && g.includes('write')) return true;
  // Legacy 'mcp' scope on a token: read+write, never admin.
  if (g.includes('mcp') && required !== 'admin') return true;
  return false;
}

/** Required scope for a tool: explicit override, else derived from annotations. */
export function requiredScopeForTool(tool: {
  name: string;
  scope?: ToolScope;
  annotations: Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint'>;
}): ToolScope {
  if (tool.scope) return tool.scope;
  if (tool.name === 'execute_extendscript') return 'admin';
  if (tool.annotations.destructiveHint) return 'admin';
  if (tool.annotations.readOnlyHint) return 'read';
  return 'write';
}

/** Plain-language description for the consent page. */
export function scopeDescription(scope: string): string {
  switch (scope) {
    case 'read':
      return 'Read project info, list items, and inspect clips (no changes)';
    case 'write':
      return 'Edit timelines, import media, apply effects, export (non-destructive edits)';
    case 'admin':
      return 'Destructive actions: delete clips, run arbitrary ExtendScript code';
    case 'offline_access':
      return 'Stay signed in (the client may refresh its access without asking again)';
    default:
      return scope;
  }
}
