import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLoginPathOutput, runShell, withLoginPath } from "../src/tools/shell";

describe("login-shell PATH resolution", () => {
  it("picks the PATH value out of noisy interactive-shell output", () => {
    expect(parseLoginPathOutput("welcome to zsh\n/usr/bin:/bin\n")).toBe("/usr/bin:/bin");
    expect(parseLoginPathOutput("/opt/homebrew/bin:/usr/bin:${PATH}\n")).toBe("/opt/homebrew/bin:/usr/bin:${PATH}");
    expect(parseLoginPathOutput("")).toBe(undefined);
  });

  it("merges the login PATH in front of the inherited one without duplicates", () => {
    const merged = withLoginPath({ PATH: "/usr/bin:/bin" }, "/opt/homebrew/bin:/usr/bin");
    expect(merged.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("leaves the environment alone when no login PATH is available", () => {
    const env = { PATH: "/usr/bin" };
    expect(withLoginPath(env, undefined)).toBe(env);
  });

  it("gives the child a PATH that is at least as rich as the host's", async () => {
    const project = mkdtempSync(join(tmpdir(), "senastr-shell-"));
    const result = await runShell(project, { command: "echo $PATH" });
    expect(result.exitCode).toBe(0);
    const reported = (result.output.split("\n").find((line) => line.includes("/")) ?? "")
      .split(":")
      .filter(Boolean);
    const inherited = (process.env.PATH ?? "").split(":").filter(Boolean);
    expect(reported.length).toBeGreaterThan(0);
    for (const dir of inherited) expect(reported).toContain(dir);
  });

  it("keeps the confinement and timeout behaviour", async () => {
    const project = mkdtempSync(join(tmpdir(), "senastr-shell-"));
    const killed = await runShell(project, { command: "sleep 30", timeout_ms: 400 });
    expect(killed.timedOut).toBe(true);
    expect(killed.output).toContain("killed after 400ms");
    expect(existsSync(project)).toBe(true);
  });
});
