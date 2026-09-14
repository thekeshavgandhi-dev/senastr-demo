import { spawn } from "node:child_process";
import { ErrorCodes, RpcError } from "@senastr/shared";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Per-stream capture cap; both streams share the budget. */
const MAX_STREAM_CHARS = 100_000;
const TOTAL_OUTPUT_CHARS = 200_000;
/** How long the one-time login-shell PATH probe may take. */
const LOGIN_PATH_TIMEOUT_MS = 3_000;

/**
 * A GUI-launched desktop app inherits a bare environment: Homebrew, nvm,
 * pyenv and `~/.local/bin` entries live in the user's shell profile, not in
 * the environment Electron was started with. Resolve PATH once from the
 * user's login shell so `node`, `git`, `cargo`, … resolve the way they do in
 * a terminal (the reference app has the same behaviour, ADR 0045).
 */
let loginPathCache: string | undefined | null = null;

/** Pick the PATH assignment out of noisy interactive-shell output. */
export function parseLoginPathOutput(stdout: string): string | undefined {
  const candidate = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes("/") && !line.includes("="))
    .pop();
  return candidate && candidate.includes(":") ? candidate : candidate || undefined;
}

export async function resolveLoginPath(shell = process.env.SHELL || "/bin/sh"): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  if (loginPathCache !== null) return loginPathCache ?? undefined;
  loginPathCache = await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const done = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(shell, ["-ilc", 'printf %s "$PATH"'], {
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      });
      let out = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        done(undefined);
      }, LOGIN_PATH_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.length > 100_000) out = out.slice(-100_000);
      });
      child.on("error", () => {
        clearTimeout(timer);
        done(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(undefined);
        const parsed = parseLoginPathOutput(out);
        done(parsed && parsed.includes("/") ? parsed : undefined);
      });
    } catch {
      done(undefined);
    }
  });
  return loginPathCache ?? undefined;
}

/** Merge the login-shell PATH in front of the inherited one. */
export function withLoginPath(env: NodeJS.ProcessEnv, loginPath: string | undefined): NodeJS.ProcessEnv {
  if (!loginPath) return env;
  const current = env.PATH ?? "";
  const parts = [...loginPath.split(":"), ...current.split(":")].filter(Boolean);
  const merged = [...new Set(parts)].join(":");
  return { ...env, PATH: merged };
}

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Run a shell command inside the project directory.
 *
 * Uses the platform shell so pipelines and globbing work as a user would
 * expect; the project-root confinement is the boundary, and privileged use
 * is gated by the permission layer (risk "exec").
 */
export async function runShell(
  project: string,
  args: Record<string, unknown>,
): Promise<ShellResult> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "command must be a non-empty string");
  }
  const timeoutRaw = args.timeout_ms;
  const timeout =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(Math.floor(timeoutRaw), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const loginPath = await resolveLoginPath();
  const env = withLoginPath({ ...process.env, SENASTR_HOST_CORE: "1" }, loginPath);

  return new Promise<ShellResult>((resolvePromise) => {
    const isWin = process.platform === "win32";
    const child = spawn(command, {
      cwd: project,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      // POSIX: run in its own process group so a timeout kill takes down
      // grandchildren too (killing only the shell would orphan `sleep 30`
      // and hold the output pipes open forever).
      detached: !isWin,
    });

    const killTree = (): void => {
      if (isWin) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);

    const cap = (s: string, d: string): string => (s + d).length > MAX_STREAM_CHARS ? (s + d).slice(-MAX_STREAM_CHARS) : s + d;

    child.stdout.on("data", (d: Buffer) => {
      stdout = cap(stdout, d.toString("utf8"));
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = cap(stderr, d.toString("utf8"));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, output: `spawn error: ${err.message}`, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const parts: string[] = [];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      parts.push(`exit: ${code ?? "null"}${timedOut ? ` (killed after ${timeout}ms)` : ""}`);
      let output = parts.join("\n") || "(no output)";
      if (output.length > TOTAL_OUTPUT_CHARS) {
        output = `${output.slice(0, TOTAL_OUTPUT_CHARS)}\n… [output truncated]`;
      }
      resolvePromise({ exitCode: code, output, timedOut });
    });
  });
}
