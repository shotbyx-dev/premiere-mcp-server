/**
 * File-queue bridge to an Adobe CEP panel.
 *
 * Protocol (inherited from hetpatel-11/Adobe_Premiere_Pro_MCP, MIT):
 * - Server and the in-app CEP panel share a temp dir.
 * - Server writes `.tmp-<uuid>.json`, atomically renames to `command-<uuid>.json`.
 * - Panel executes the ExtendScript via CSInterface.evalScript, deletes the
 *   command file, and writes `response-<uuid>.json` atomically.
 * - Panel writes `bridge-heartbeat.json` every ~250ms: { t, started }.
 *
 * This class is app-agnostic: Premiere and After Effects each get an instance
 * with their own temp dir / heartbeat file / process names.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const HEARTBEAT_STALE_MS = 2500;
const PANEL_ABSENT_MS = 1500;
const POLL_MS = 150;
const DEFAULT_TIMEOUT_MS = 60000;
const LAUNCH_WAIT_MS = 45000;

export interface BridgeOptions {
  /** e.g. "Premiere Pro" — used in error messages */
  appName: string;
  /** Shared temp dir with the CEP panel */
  tempDir: string;
  /** Heartbeat filename, e.g. "bridge-heartbeat.json" */
  heartbeatFile: string;
  /** Windows process image name, e.g. "Adobe Premiere Pro.exe" */
  windowsProcessName: string;
  /** Install dir scan roots, e.g. "C:\Program Files\Adobe" */
  windowsInstallRoot: string;
  /** Folder name prefix to scan, e.g. "Adobe Premiere Pro" */
  installFolderPrefix: string;
  /** Executable name inside the install folder */
  windowsExeName: string;
}

export interface HostStatus {
  ready: boolean;
  status: string;
  detail?: string;
  userActionRequired?: boolean;
  launched?: boolean;
}

export class FileQueueBridge {
  private opts: BridgeOptions;
  private prelude: string;
  private installPath: string | null = null;
  private launchPath: string | null = null;
  private initialized = false;

  constructor(opts: BridgeOptions, prelude: string) {
    this.opts = opts;
    this.prelude = prelude;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.opts.tempDir, { recursive: true, mode: 0o700 });
    await this.detectInstallation();
    this.initialized = true;
  }

  get tempDir(): string {
    return this.opts.tempDir;
  }

  /** Prepend the JSON-compat prelude; wrap so top-level `return` stays valid. */
  buildExecutableScript(script: string): string {
    const body = script.trim();
    if (/^\(function\s*\(\)\s*\{/.test(body)) return this.prelude + body;
    return this.prelude + '(function(){\n' + body + '\n})();';
  }

  async executeScript(script: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.initialized) await this.initialize();
    if (script.includes('\0')) throw new Error('Script contains NUL byte — rejected.');

    const commandId = randomUUID();
    const staging = join(this.opts.tempDir, `.tmp-${commandId}.json`);
    const commandFile = join(this.opts.tempDir, `command-${commandId}.json`);
    const responseFile = join(this.opts.tempDir, `response-${commandId}.json`);

    try {
      await writeFile(
        staging,
        JSON.stringify({
          id: commandId,
          script: this.buildExecutableScript(script),
          timeoutMs,
          timestamp: new Date().toISOString(),
        })
      );
      await rename(staging, commandFile);
      return await this.waitForResponse(responseFile, timeoutMs);
    } finally {
      await unlink(staging).catch(() => {});
      await unlink(commandFile).catch(() => {});
      await unlink(responseFile).catch(() => {});
    }
  }

  private async readHeartbeat(): Promise<{ t: number; started: boolean } | null> {
    try {
      const raw = await readFile(join(this.opts.tempDir, this.opts.heartbeatFile), 'utf8');
      const parsed = JSON.parse(raw) as { t?: unknown; started?: unknown };
      if (typeof parsed?.t !== 'number' || !Number.isFinite(parsed.t)) return null;
      if (Date.now() - parsed.t > HEARTBEAT_STALE_MS) return null;
      return { t: parsed.t, started: parsed.started === true };
    } catch {
      return null;
    }
  }

  private async waitForResponse(responseFile: string, timeoutMs: number): Promise<unknown> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let raw: string | undefined;
      try {
        raw = await readFile(responseFile, 'utf8');
      } catch {
        raw = undefined;
      }
      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw) as { result?: unknown; success?: boolean; error?: string };
          if (parsed.result !== undefined) return parsed.result;
          if (parsed.success === false) throw new Error(parsed.error || 'Bridge reported failure');
          return parsed;
        } catch (e) {
          if (e instanceof SyntaxError) {
            // Torn read — panel writes are not atomic on every host; keep polling briefly.
          } else {
            throw e;
          }
        }
      }
      if (Date.now() - start >= PANEL_ABSENT_MS) {
        const beat = await this.readHeartbeat();
        if (!beat) {
          throw new Error(
            `${this.opts.appName} bridge panel is not running. Open ${this.opts.appName}, ` +
              `choose Window > Extensions and open the MCP Bridge panel, then click Start Bridge.`
          );
        }
        if (!beat.started) {
          throw new Error(
            `Bridge panel is open but not started. Click "Start Bridge" in the panel UI.`
          );
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `Bridge response timeout after ${timeoutMs}ms. A modal dialog in ${this.opts.appName} ` +
        `may be blocking ExtendScript — dismiss any dialogs and retry.`
    );
  }

  /** Readiness check with optional auto-launch. Never retries blindly. */
  async ensureHost(options: { launchIfNeeded?: boolean; waitMs?: number } = {}): Promise<HostStatus> {
    if (!this.initialized) await this.initialize();
    const launchIfNeeded = options.launchIfNeeded !== false;
    const waitMs = options.waitMs ?? LAUNCH_WAIT_MS;

    const beat = await this.readHeartbeat();
    if (beat?.started) return { ready: true, status: 'connected' };
    if (beat && !beat.started) {
      return {
        ready: false,
        status: 'bridge_not_started',
        detail: 'Panel is open but the bridge is not started. Click "Start Bridge" in the panel.',
        userActionRequired: true,
      };
    }

    const running = await this.isProcessRunning();
    let launched = false;
    if (!running && launchIfNeeded && this.launchPath) launched = this.launchApp();

    if (!running && !launched) {
      return {
        ready: false,
        status: 'app_not_running',
        detail: this.installPath
          ? `${this.opts.appName} is installed but could not be launched here. Open it yourself; the bridge panel auto-starts.`
          : `${this.opts.appName} was not found in the usual install location. Open it manually and start the bridge panel.`,
        userActionRequired: true,
      };
    }

    const connected = await this.waitForStartedHeartbeat(waitMs);
    if (connected) return { ready: true, status: 'connected', launched };
    return {
      ready: false,
      status: 'bridge_unavailable',
      detail: launched
        ? `${this.opts.appName} was launched but the bridge panel did not connect in time. Confirm the panel is visible under Window > Extensions, then retry.`
        : `The bridge panel did not respond. Open ${this.opts.appName} and start the panel.`,
      userActionRequired: true,
      launched,
    };
  }

  private async waitForStartedHeartbeat(waitMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const beat = await this.readHeartbeat();
      if (beat?.started) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  private async isProcessRunning(): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('tasklist', [
          '/FI',
          `IMAGENAME eq ${this.opts.windowsProcessName}`,
        ], { timeout: 5000 });
        return new RegExp(this.opts.windowsProcessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(stdout);
      }
      if (process.platform === 'darwin') {
        await execFileAsync('pgrep', ['-f', this.opts.appName], { timeout: 3000 });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private launchApp(): boolean {
    if (!this.launchPath) return false;
    try {
      const child =
        process.platform === 'win32'
          ? spawn(this.launchPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
          : spawn('open', ['-a', this.launchPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  private async detectInstallation(): Promise<void> {
    if (process.platform !== 'win32') return; // Windows-first; extend per platform as needed
    const root = process.env['ProgramFiles'] || 'C:\\Program Files';
    let entries: string[] = [];
    try {
      entries = await readdir(join(root, this.opts.windowsInstallRoot));
    } catch {
      return;
    }
    const candidates = entries
      .filter((e) => e.startsWith(this.opts.installFolderPrefix))
      .sort()
      .reverse(); // newest release first
    for (const c of candidates) {
      const exe = join(root, this.opts.windowsInstallRoot, c, this.opts.windowsExeName);
      try {
        await access(exe);
        this.installPath = join(root, this.opts.windowsInstallRoot, c);
        this.launchPath = exe;
        return;
      } catch {
        /* keep scanning */
      }
    }
  }
}

/** Convenience: read the ExtendScript JSON-compat prelude shipped with the server. */
export async function loadPrelude(preludePath: string): Promise<string> {
  return readFile(preludePath, 'utf8');
}
