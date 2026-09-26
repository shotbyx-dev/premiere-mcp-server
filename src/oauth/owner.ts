/**
 * Owner passphrase for the OAuth consent page.
 *
 * Precedence: PREMIERE_MCP_OWNER_SECRET env > persisted <home>/owner-secret >
 * generate-once (persisted 0600, printed to the console so the installer/user
 * can capture it). The installer generates and stores this itself; the
 * generate-once path is the standalone fallback.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { newSecret } from './store.js';

export function ownerSecretPath(homeDir: string): string {
  return join(homeDir, 'owner-secret');
}

export async function ensureOwnerSecret(
  homeDir: string,
  envSecret: string | null
): Promise<{ secret: string; generated: boolean }> {
  if (envSecret && envSecret.length >= 8) return { secret: envSecret, generated: false };
  const file = ownerSecretPath(homeDir);
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing.length >= 8) return { secret: existing, generated: false };
  } catch {
    // fall through to generation
  }
  const secret = newSecret();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, secret + '\n', { mode: 0o600 });
  return { secret, generated: true };
}
