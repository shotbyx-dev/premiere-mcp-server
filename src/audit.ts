/**
 * Audit log: every tool invocation is appended as one JSONL line.
 * Since MCP tools can execute arbitrary ExtendScript in Premiere / After
 * Effects and spend real money (video generation), this log is the
 * accountability trail. Never log raw secrets or full image bytes.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  ts: string;
  caller: string; // clientId from verified auth
  tool: string;
  argsSummary: Record<string, unknown>; // redacted
  outcome: 'ok' | 'error';
  detail?: string;
}

const SENSITIVE_KEYS = new Set([
  'token',
  'apiKey',
  'api_key',
  'imageBytes',
  'image_bytes',
  'bytesBase64Encoded',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else if (typeof v === 'string' && v.length > 2000) {
        out[k] = v.slice(0, 200) + `...[${v.length} chars]`;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function summarizeArgs(args: unknown): Record<string, unknown> {
  const r = redact(args);
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r };
}

export class AuditLog {
  private path: string;
  private ready: Promise<void>;

  constructor(path: string) {
    this.path = path;
    this.ready = mkdir(dirname(path), { recursive: true }).then(() => {});
  }

  async record(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    await this.ready;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    await appendFile(this.path, line, 'utf8').catch((e) => {
      console.error('[audit] failed to append:', e);
    });
  }
}
