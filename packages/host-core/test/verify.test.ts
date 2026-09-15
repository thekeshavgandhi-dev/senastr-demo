import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectChecks, packageManager, verifyProject } from "../src/tools/verify";

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "senastr-verify-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const pkg = (scripts: Record<string, string>, extra = ""): string =>
  JSON.stringify({ name: "demo", version: "1.0.0", scripts, ...(extra ? JSON.parse(extra) : {}) });

describe("detectChecks", () => {
  it("picks typecheck, lint, test and build scripts from package.json", () => {
    const dir = project({
      "package.json": pkg({
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        test: "vitest run",
        build: "tsc -p .",
      }),
    });
    const steps = detectChecks(dir);
    expect(steps.map((s) => s.category)).toEqual(["typecheck", "lint", "test", "build"]);
    expect(steps.every((s) => s.command.startsWith("npm run"))).toBe(true);
  });

  it("chooses the package manager from the lockfile", () => {
    expect(packageManager(project({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
    expect(packageManager(project({ "yarn.lock": "" }))).toBe("yarn");
    expect(packageManager(project({ "bun.lockb": "" }))).toBe("bun");
    expect(packageManager(project({ "package.json": "{}" }))).toBe("npm");
    const dir = project({ "package.json": pkg({ test: "vitest run" }), "pnpm-lock.yaml": "" });
    expect(detectChecks(dir)[0].command).toBe("pnpm run test");
  });

  it("falls back to tsc --noEmit for a TypeScript project without a script", () => {
    const dir = project({ "package.json": pkg({}), "tsconfig.json": "{}" });
    expect(detectChecks(dir).some((s) => s.command.includes("tsc --noEmit"))).toBe(true);
  });

  it("detects Python, Rust, Go and Make targets", () => {
    const py = project({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n", "tests/test_a.py": "" });
    expect(detectChecks(py).map((s) => s.command)).toContain("pytest -q");

    const rust = project({ "Cargo.toml": "[package]" });
    const rustCommands = detectChecks(rust).map((s) => s.command);
    expect(rustCommands).toContain("cargo test");
    expect(rustCommands).toContain("cargo check --all-targets");

    const go = project({ "go.mod": "module demo" });
    expect(detectChecks(go).map((s) => s.command)).toContain("go test ./...");

    const make = project({ Makefile: "test:\n\tpytest\nlint:\n\truff check .\nbuild:\n\ttrue\n" });
    const makeCommands = detectChecks(make).map((s) => s.command);
    expect(makeCommands).toEqual(expect.arrayContaining(["make test", "make lint", "make build"]));
  });

  it("returns nothing for an empty directory", () => {
    expect(detectChecks(project({ "README.md": "# hi" }))).toEqual([]);
  });

  it("never returns duplicate commands and orders cheap checks first", () => {
    const dir = project({
      "package.json": pkg({ test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" }),
    });
    const steps = detectChecks(dir);
    expect(new Set(steps.map((s) => s.command)).size).toBe(steps.length);
    expect(steps[0].category).toBe("typecheck");
  });
});

describe("verifyProject", () => {
  it("reports PASS with exit codes when the checks succeed", async () => {
    const dir = project({ "package.json": pkg({ test: "exit 0" }) });
    const result = await verifyProject(dir, {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("verify: PASS");
    expect(result.output).toContain("exit 0");
  });

  it("reports FAIL and stops at the first failing check", async () => {
    const dir = project({ "package.json": pkg({ lint: "echo boom 1>&2; exit 1", test: "sleep 30" }) });
    const result = await verifyProject(dir, { timeout_ms: 30_000 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("verify: FAIL");
    expect(result.output).toContain("boom");
    // Fail fast: the slow suite never ran.
    expect(result.output).not.toContain("sleep 30");
  });

  it("runs a single category when asked", async () => {
    const dir = project({ "package.json": pkg({ lint: "exit 0", test: "exit 0" }) });
    const result = await verifyProject(dir, { only: "lint" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("lint");
    expect(result.output).not.toContain("tests");
  });

  it("runs an explicit command instead of the detected suite", async () => {
    const dir = project({ "package.json": pkg({ test: "exit 1" }) });
    const result = await verifyProject(dir, { command: "echo hello-from-command" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello-from-command");
    expect(result.output).toContain("explicit command");
  });

  it("explains itself when the project has no detectable checks", async () => {
    const result = await verifyProject(project({ "README.md": "# nothing here" }), {});
    expect(result.output).toContain("no checks detected");
  });

  it("rejects an unknown category", async () => {
    await expect(verifyProject(project({}), { only: "nonsense" })).rejects.toThrow(/only must be one of/);
  });

  it("surfaces a timeout as a failure rather than hanging", async () => {
    const dir = project({ "package.json": pkg({ test: "sleep 30" }) });
    const result = await verifyProject(dir, { timeout_ms: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timed out/);
  }, 30_000);
});
