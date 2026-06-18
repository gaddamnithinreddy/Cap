/**
 * Sandbox provider abstraction.
 *
 * Vendi originally ran its isolated coding environments on E2B. This module replaces
 * E2B with Daytona while preserving the exact surface the rest of the server relies on.
 * It exposes:
 *
 *   1. An E2B-compatible `Sandbox` class (static `create` / `connect` plus
 *      `commands.run`, `files.read`, `files.write`, `getHost`, `kill`, `sandboxId`)
 *      so the existing services migrate by swapping a single import line.
 *   2. A small functional API (`createSandbox`, `runCommand`, `writeFile`,
 *      `readFile`, `getPreviewUrl`, `destroySandbox`) for provider-agnostic callers.
 *
 * Nothing outside this file needs to know that the provider is Daytona.
 */
import { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import { env } from "../config/env";

let _client: Daytona | null = null;

/** Lazily-constructed Daytona client (so missing creds only fail when sandboxes are used). */
function client(): Daytona {
  if (!_client) {
    _client = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      // The SDK option is `apiUrl`; we expose it as DAYTONA_SERVER_URL for parity with the docs.
      apiUrl: env.DAYTONA_SERVER_URL,
      target: env.DAYTONA_TARGET,
    });
  }
  return _client;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  /** Max time to wait for the command, in milliseconds (mapped to Daytona's seconds). */
  requestTimeoutMs?: number;
  /** Run detached and return immediately — for daemons, dev servers, and the agent process. */
  background?: boolean;
}

export interface CreateOptions {
  /** Sandbox idle lifetime in milliseconds (mapped to Daytona's autoStop interval in minutes). */
  timeoutMs?: number;
  /** Environment variables to inject into the sandbox. */
  envs?: Record<string, string>;
}

/**
 * Thrown when a (non-background) command exits non-zero. Mirrors the shape of E2B's
 * `CommandExitError` (`.exitCode`, `.stdout`, `.stderr`, `.result`) so existing
 * `.catch` handlers that read `e.result?.stdout` keep working unchanged.
 */
export class CommandExitError extends Error {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: CommandResult;

  constructor(result: CommandResult) {
    super(
      `Command exited with code ${result.exitCode}` +
        (result.stderr ? `: ${result.stderr}` : result.stdout ? `: ${result.stdout}` : "")
    );
    this.name = "CommandExitError";
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.result = result;
  }
}

// A single reusable session id for detached/background commands per sandbox handle.
const BG_SESSION_ID = "vendi-bg";

/**
 * E2B-compatible sandbox handle backed by a Daytona sandbox.
 */
export class Sandbox {
  /** Underlying Daytona sandbox — escape hatch for provider-specific needs. */
  readonly daytona: DaytonaSandbox;
  private bgSessionReady = false;

  private constructor(daytona: DaytonaSandbox) {
    this.daytona = daytona;
  }

  /** Stable id used across requests/pods (persisted in the DB). */
  get sandboxId(): string {
    return this.daytona.id;
  }

  /**
   * Create a fresh sandbox.
   *
   * `template` is accepted for call-site compatibility with the previous E2B API but
   * the boot image is resolved from configuration: when `DAYTONA_SNAPSHOT` is set the
   * sandbox boots from that snapshot, otherwise it boots the default Daytona snapshot
   * and the session bootstrap provisions dependencies at runtime (apt / npm) — exactly
   * as the original code already did inside the session.
   */
  static async create(_template?: string, opts: CreateOptions = {}): Promise<Sandbox> {
    const autoStopInterval =
      opts.timeoutMs && opts.timeoutMs > 0 ? Math.max(1, Math.round(opts.timeoutMs / 60_000)) : undefined;

    const base = {
      envVars: opts.envs,
      public: true,
      ...(autoStopInterval !== undefined ? { autoStopInterval } : {}),
    };

    const snapshot = env.DAYTONA_SNAPSHOT || undefined;

    let created: DaytonaSandbox;
    try {
      created = await client().create(snapshot ? { ...base, snapshot } : { ...base });
    } catch (err) {
      // If a configured snapshot can't be used, fall back to the default snapshot.
      if (snapshot) created = await client().create({ ...base });
      else throw err;
    }

    return new Sandbox(created);
  }

  /** Reconnect to an existing sandbox by its id. */
  static async connect(sandboxId: string): Promise<Sandbox> {
    const found = await client().get(sandboxId);
    return new Sandbox(found);
  }

  commands = {
    run: async (command: string, opts: RunOptions = {}): Promise<CommandResult> => {
      const timeoutSec = opts.requestTimeoutMs
        ? Math.max(1, Math.ceil(opts.requestTimeoutMs / 1000))
        : undefined;

      // Detached execution: run asynchronously inside a persistent session and return
      // immediately. Daemons in the command (e.g. trailing `&`) keep running afterwards.
      if (opts.background) {
        await this.ensureBgSession();
        const res = await this.daytona.process.executeSessionCommand(BG_SESSION_ID, {
          command,
          runAsync: true,
        });
        return {
          stdout: res.output ?? res.stdout ?? "",
          stderr: res.stderr ?? "",
          exitCode: res.exitCode ?? 0,
        };
      }

      const res = await this.daytona.process.executeCommand(command, undefined, undefined, timeoutSec);
      const result: CommandResult = {
        // Daytona merges output into `result`; `artifacts.stdout` is the same value.
        stdout: res.result ?? res.artifacts?.stdout ?? "",
        stderr: "",
        exitCode: res.exitCode ?? 0,
      };
      // Match E2B semantics: a non-zero exit throws (callers rely on this in try/catch).
      if (result.exitCode !== 0) throw new CommandExitError(result);
      return result;
    },
  };

  files = {
    read: async (path: string): Promise<string> => {
      const buf = await this.daytona.fs.downloadFile(path);
      return buf.toString("utf8");
    },
    write: async (path: string, content: string): Promise<void> => {
      await this.daytona.fs.uploadFile(Buffer.from(content, "utf8"), path);
    },
  };

  /** Host (without scheme) for a forwarded port — mirrors E2B's `getHost()`. */
  async getHost(port: number): Promise<string> {
    const link = await this.daytona.getPreviewLink(port);
    return link.url.replace(/^https?:\/\//, "");
  }

  /** Full public preview URL for a forwarded port. */
  async getPreviewUrl(port: number): Promise<string> {
    const link = await this.daytona.getPreviewLink(port);
    return link.url;
  }

  /** Destroy the sandbox. */
  async kill(): Promise<void> {
    await this.daytona.delete();
  }

  private async ensureBgSession(): Promise<void> {
    if (this.bgSessionReady) return;
    try {
      await this.daytona.process.createSession(BG_SESSION_ID);
    } catch {
      // Session may already exist (e.g. after reconnect) — reuse it.
    }
    this.bgSessionReady = true;
  }
}

// ── Functional provider API ───────────────────────────────────────────────────
// Thin wrappers so callers can stay fully provider-agnostic.

export function createSandbox(template?: string, opts?: CreateOptions): Promise<Sandbox> {
  return Sandbox.create(template, opts);
}

export function connectSandbox(sandboxId: string): Promise<Sandbox> {
  return Sandbox.connect(sandboxId);
}

export function runCommand(sandbox: Sandbox, command: string, opts?: RunOptions): Promise<CommandResult> {
  return sandbox.commands.run(command, opts);
}

export function writeFile(sandbox: Sandbox, path: string, content: string): Promise<void> {
  return sandbox.files.write(path, content);
}

export function readFile(sandbox: Sandbox, path: string): Promise<string> {
  return sandbox.files.read(path);
}

export function getPreviewUrl(sandbox: Sandbox, port: number): Promise<string> {
  return sandbox.getPreviewUrl(port);
}

export function destroySandbox(sandbox: Sandbox): Promise<void> {
  return sandbox.kill();
}
