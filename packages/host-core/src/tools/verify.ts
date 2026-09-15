import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCodes, RpcError } from "@senastr/shared";
import { runShell } from "./shell";

/**
 * The `verify` tool: run the project's *real* checks and report pass/fail.
 *
 * "I think it works" is the failure mode this exists to remove. Rather than
 * trusting the model to remember the right command, we detect the toolchain
 * from the repository (Node/Python/Rust/Go/Java/Makefile), run the checks in
 * cheap-first order, and hand back a condensed, evidence-shaped report:
 * every command, its exit code, and the tail of its output.
 */

export type CheckCategory = "typecheck" | "lint" | "test" | "build";

export interface CheckStep {
  category: CheckCategory;
  label: string;
  command: string;
}

export interface CheckOutcome {
  category: CheckCategory;
  label: string;
  command: string;
  exitCode: number | null;
  ok: boolean;
  timedOut: boolean;
  /** Tail of the combined output, trimmed to stay context-friendly. */
  output: string;
}

const DEFAULT_TOTAL_MS = 300_000;
const MAX_TOTAL_MS = 600_000;
const PER_STEP_MS = 120_000;
const OUTPUT_TAIL_CHARS = 2_500;
const FINAL_REPORT_CHARS = 12_000;
const ORDER: CheckCategory[] = ["typecheck", "lint", "test", "build"];

/**
 * Inspect a project directory and return the checks that apply to it.
 * Exported so tests can assert detection without spawning processes.
 */
export function detectChecks(project: string): CheckStep[] {
  const steps: CheckStep[] = [];
  const has = (file: string): boolean => existsSync(join(project, file));

  const pkg = readJson(join(project, "package.json"));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pm = packageManager(project);
    const run = (name: string): string => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`);
    const pick = (names: string[], category: CheckCategory, label: string): void => {
      const found = names.find((n) => typeof scripts[n] === "string");
      if (found) steps.push({ category, label, command: run(found) });
    };
    // Cheapest, most informative first.
    pick(["typecheck", "type-check", "check-types", "tsc"], "typecheck", "typecheck");
    pick(["lint", "eslint", "biome", "format:check", "prettier:check"], "lint", "lint");
    pick(["test", "test:unit", "vitest", "jest"], "test", "tests");
    pick(["build", "compile"], "build", "build");

    // A TypeScript project with no typecheck script is still worth checking.
    if (!steps.some((s) => s.category === "typecheck") && (has("tsconfig.json") || pkg.devDependencies?.typescript)) {
      steps.unshift({
        category: "typecheck",
        label: "typecheck",
        command: pm === "npm" ? "npx --no-install tsc --noEmit" : `${pm} exec tsc --noEmit`,
      });
    }
  }

  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const py = readText(join(project, "pyproject.toml"));
    const runner = has("poetry.lock") ? "poetry run" : "";
    if (/\[tool\.mypy\]/.test(py) || has("mypy.ini")) {
      steps.push({ category: "typecheck", label: "mypy", command: `${runner} mypy .`.trim() });
    }
    if (/\[tool\.ruff\]/.test(py) || has("ruff.toml") || has(".flake8")) {
      steps.push({ category: "lint", label: "lint", command: `${runner} ruff check .`.trim() });
    }
    if (/\[tool\.pytest/.test(py) || has("tests") || has("test")) {
      steps.push({ category: "test", label: "pytest", command: `${runner} pytest -q`.trim() });
    }
  }

  if (has("Cargo.toml")) {
    steps.push({ category: "build", label: "cargo check", command: "cargo check --all-targets" });
    steps.push({ category: "test", label: "cargo test", command: "cargo test" });
    steps.push({ category: "lint", label: "clippy", command: "cargo clippy --all-targets" });
  }

  if (has("go.mod")) {
    steps.push({ category: "build", label: "go build", command: "go build ./..." });
    steps.push({ category: "lint", label: "go vet", command: "go vet ./..." });
    steps.push({ category: "test", label: "go test", command: "go test ./..." });
  }

  if (has("Makefile")) {
    const makefile = readText(join(project, "Makefile"));
    const target = (name: string): boolean => new RegExp(`^${name}\\s*:`, "m").test(makefile);
    if (target("test")) steps.push({ category: "test", label: "make test", command: "make test" });
    if (target("lint")) steps.push({ category: "lint", label: "make lint", command: "make lint" });
    if (target("build")) steps.push({ category: "build", label: "make build", command: "make build" });
  }

  if (has("pom.xml")) steps.push({ category: "test", label: "maven test", command: "mvn -q -B test" });
  if (has("build.gradle") || has("build.gradle.kts")) {
    steps.push({ category: "test", label: "gradle test", command: "gradle test --console=plain" });
  }

  // Stable, cheap-first ordering; dedupe identical commands.
  const seen = new Set<string>();
  return steps
    .filter((s) => {
      if (seen.has(s.command)) return false;
      seen.add(s.command);
      return true;
    })
    .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
}

export function packageManager(project: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(join(project, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(project, "yarn.lock"))) return "yarn";
  if (existsSync(join(project, "bun.lockb")) || existsSync(join(project, "bun.lock"))) return "bun";
  return "npm";
}

/**
 * Run the detected checks (or one explicit command) and format the report.
 */
export async function verifyProject(
  project: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; output: string }> {
  const only = typeof args.only === "string" ? args.only : "auto";
  if (only !== "auto" && !ORDER.includes(only as CheckCategory)) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `verify.only must be one of: auto, ${ORDER.join(", ")}`);
  }
  const totalRaw = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) ? args.timeout_ms : DEFAULT_TOTAL_MS;
  // A 5s floor keeps the tool usable for a quick single check; the default
  // (300s) is what a real suite needs.
  const total = Math.min(Math.max(5_000, Math.floor(totalRaw)), MAX_TOTAL_MS);
  const explicit = typeof args.command === "string" ? args.command.trim() : "";

  const steps: CheckStep[] = explicit
    ? [{ category: "test", label: "custom command", command: explicit }]
    : detectChecks(project).filter((s) => only === "auto" || s.category === only);

  if (!steps.length) {
    return {
      ok: true,
      output: [
        "verify: no checks detected for this project.",
        "",
        "No package.json scripts, Makefile targets, Cargo.toml, go.mod, or Python test config were found.",
        "Run the project's checks explicitly with verify({ command: \"…\" }) or run_command, and report that output as your evidence.",
      ].join("\n"),
    };
  }

  const outcomes: CheckOutcome[] = [];
  const deadline = Date.now() + total;
  let stoppedEarly = false;

  for (const step of steps) {
    if (Date.now() >= deadline) {
      stoppedEarly = true;
      break;
    }
    const budget = Math.min(PER_STEP_MS, Math.max(5_000, deadline - Date.now()));
    const result = await runShell(project, { command: step.command, timeout_ms: budget });
    const ok = result.exitCode === 0 && !result.timedOut;
    outcomes.push({
      category: step.category,
      label: step.label,
      command: step.command,
      exitCode: result.exitCode,
      ok,
      timedOut: result.timedOut,
      output: tail(result.output, OUTPUT_TAIL_CHARS),
    });
    // Fail fast on the cheap checks: if the code does not typecheck, running
    // a three-minute test suite only produces noise.
    if (!ok && step.category !== "build") break;
  }

  const passed = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o) => !o.ok);
  const allOk = failed.length === 0;

  const lines: string[] = [
    `verify: ${allOk ? "PASS" : "FAIL"} — ${passed}/${outcomes.length} check(s) passed`,
    "",
  ];
  for (const outcome of outcomes) {
    lines.push(
      `${outcome.ok ? "PASS" : "FAIL"}  ${outcome.label}  ·  ${outcome.command}` +
        `  ·  exit ${outcome.exitCode ?? "null"}${outcome.timedOut ? " (timed out)" : ""}`,
    );
    if (!outcome.ok) lines.push(indent(outcome.output));
  }
  if (stoppedEarly) {
    lines.push("", `(stopped early — the ${total / 1000}s verification budget was exhausted)`);
  }
  if (explicit) {
    lines.push("", "This was an explicit command, not the project's detected suite.");
  }
  lines.push(
    "",
    allOk
      ? "All executed checks passed. Report the commands and exit codes as your evidence."
      : "Fix the first failure above, then re-run verify. Do not report the task as done while a check fails.",
  );

  let output = lines.join("\n");
  if (output.length > FINAL_REPORT_CHARS) output = `${output.slice(0, FINAL_REPORT_CHARS)}\n… [report truncated]`;
  return { ok: allOk, output };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(-max)}`;
}

function readJson(file: string): Record<string, any> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}
