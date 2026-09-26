/**
 * After Effects bridge client.
 *
 * Talks to the "MCP Bridge Auto" ScriptUI panel (a .jsx installed into After
 * Effects' ScriptUI Panels folder, adapted from Dakkshin/after-effects-mcp,
 * MIT — see THIRD-PARTY-NOTICES.md) through a simple file protocol:
 *
 *   <bridgeDir>/ae_command.json  — server writes {command, args, timestamp, status:"pending"}
 *   <bridgeDir>/ae_mcp_result.json — panel writes { _commandExecuted, ...result }
 *
 * The panel polls the command file roughly every 2s, so round-trips are slower
 * than the Premiere CEP bridge. There is no heartbeat: liveness is probed by a
 * cheap getProjectInfo round-trip in ae_verify_connection.
 *
 * The panel hardcodes the bridge folder to %USERPROFILE%\\Documents\\ae-mcp-bridge,
 * so the server default matches it. Override with AE_TEMP_DIR if you relocate it
 * (you would also have to edit the .jsx).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AeBridgeOptions {
  bridgeDir: string;
  processName?: string; // default AfterFX.exe
  scanRoots?: string[]; // default [C:\Program Files\Adobe]
}

export interface AeCommandResult {
  ok: boolean;
  result: unknown;
  ms: number;
}

export interface AeHostInfo {
  processRunning: boolean;
  installDir: string | null;
  afterFxExe: string | null;
  aerenderExe: string | null;
}

const ATOMIC_WRITE = { flag: 'w' };

export class AeBridge {
  readonly bridgeDir: string;
  private readonly processName: string;
  private readonly scanRoots: string[];
  private installDirCache: string | null | undefined;

  constructor(opts: AeBridgeOptions) {
    this.bridgeDir = opts.bridgeDir;
    this.processName = opts.processName ?? 'AfterFX.exe';
    this.scanRoots = opts.scanRoots ?? ['C:\\Program Files\\Adobe'];
    mkdirSync(this.bridgeDir, { recursive: true });
  }

  get commandPath(): string {
    return join(this.bridgeDir, 'ae_command.json');
  }
  get resultPath(): string {
    return join(this.bridgeDir, 'ae_mcp_result.json');
  }

  /** Find the After Effects install directory by scanning for AfterFX.exe. */
  findInstallDir(): string | null {
    if (this.installDirCache !== undefined) return this.installDirCache;
    for (const root of this.scanRoots) {
      if (!existsSync(root)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      const matches = entries
        .filter((d) => /^Adobe After Effects/i.test(d))
        .sort()
        .reverse(); // newest year first (string sort works for YYYY)
      for (const m of matches) {
        const dir = join(root, m);
        if (existsSync(join(dir, 'AfterFX.exe'))) {
          this.installDirCache = dir;
          return dir;
        }
      }
    }
    this.installDirCache = null;
    return null;
  }

  /** Is After Effects currently running? (Windows tasklist; always false off-Windows.) */
  async isProcessRunning(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${this.processName}`, '/NH']);
      return stdout.toLowerCase().includes(this.processName.toLowerCase());
    } catch {
      return false;
    }
  }

  async hostInfo(): Promise<AeHostInfo> {
    const installDir = this.findInstallDir();
    return {
      processRunning: await this.isProcessRunning(),
      installDir,
      afterFxExe: installDir ? join(installDir, 'AfterFX.exe') : null,
      aerenderExe: installDir && existsSync(join(installDir, 'Support Files', 'aerender.exe'))
        ? join(installDir, 'Support Files', 'aerender.exe')
        : null,
    };
  }

  /** Launch After Effects if it is not running. Returns true if a launch was attempted. */
  async launchIfDown(): Promise<{ launched: boolean; exe: string | null }> {
    if (await this.isProcessRunning()) return { launched: false, exe: null };
    const dir = this.findInstallDir();
    if (!dir || process.platform !== 'win32') return { launched: false, exe: null };
    const exe = join(dir, 'AfterFX.exe');
    const { spawn } = await import('node:child_process');
    spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dir }).unref();
    return { launched: true, exe };
  }

  /** Write a command and wait for the panel's result. */
  async runCommand(command: string, args: Record<string, unknown> = {}, timeoutMs = 60000): Promise<AeCommandResult> {
    const started = Date.now();
    // Clear any stale result first so we never match a previous run.
    writeFileSync(
      this.resultPath,
      JSON.stringify({ status: 'waiting', _commandExecuted: null, timestamp: new Date().toISOString() }),
      ATOMIC_WRITE,
    );
    const payload = { command, args, timestamp: new Date().toISOString(), status: 'pending' };
    const tmp = join(this.bridgeDir, `ae_command.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    // Atomic rename so the panel never reads a half-written file.
    const { renameSync } = await import('node:fs');
    renameSync(tmp, this.commandPath);

    const pollMs = 250;
    while (Date.now() - started < timeoutMs) {
      const raw = this.tryRead(this.resultPath);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed._commandExecuted === command && parsed.status !== 'waiting') {
            return { ok: true, result: parsed, ms: Date.now() - started };
          }
        } catch {
          // not JSON yet; keep polling
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `AE bridge timed out after ${timeoutMs}ms waiting for "${command}". ` +
        'Is After Effects running with the MCP Bridge Auto panel open (auto-run ON)?',
    );
  }

  private tryRead(p: string): string | null {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
}

/** Default bridge dir matching the .jsx panel: %USERPROFILE%\Documents\ae-mcp-bridge */
export function defaultAeBridgeDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || tmpdir();
  return join(home, 'Documents', 'ae-mcp-bridge');
}
