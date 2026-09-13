import { spawn } from "node:child_process";
import { ErrorCodes, RpcError } from "@senastr/shared";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Per-stream capture cap; both streams share the budget. */
const MAX_STREAM_CHARS = 100_000;
const TOTAL_OUTPUT_CHARS = 200_000;

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
export function runShell(
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

  return new Promise<ShellResult>((resolvePromise) => {
    const isWin = process.platform === "win32";
    const child = spawn(command, {
      cwd: project,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SENASTR_HOST_CORE: "1" },
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
