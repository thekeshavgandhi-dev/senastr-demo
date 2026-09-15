import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryService, redact, scoreDocument } from "../src/memory";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "senastr-memory-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PROJECT = "/home/me/projects/acme";

describe("MemoryService", () => {
  let memory: MemoryService;
  let dataDir: string;

  beforeEach(() => {
    dataDir = tmp();
    memory = new MemoryService(dataDir);
  });

  const project = { scope: "project" as const, projectPath: PROJECT };
  const global = { scope: "global" as const, projectPath: null };

  it("starts empty and reports an empty index", () => {
    expect(memory.index(project).entries).toEqual([]);
    expect(memory.index(project).size).toBe(0);
  });

  it("writes, reads and lists a topic", () => {
    memory.write(project, "auth-flow", "# Auth\n\nTokens rotate every 30 days.");
    const entry = memory.read(project, "auth-flow");
    expect(entry?.content).toContain("rotate every 30 days");
    expect(entry?.summary).toBe("Auth");
    expect(memory.index(project).entries.map((e) => e.key)).toEqual(["auth-flow"]);
  });

  it("appends to a topic instead of replacing it when asked", () => {
    memory.write(project, "notes", "first");
    memory.write(project, "notes", "second", "append");
    const entry = memory.read(project, "notes");
    expect(entry?.content).toBe("first\n\nsecond");
    memory.write(project, "notes", "only", "replace");
    expect(memory.read(project, "notes")?.content).toBe("only");
  });

  it("slugifies keys so different spellings land on one note", () => {
    memory.write(project, "Auth Flow", "one");
    memory.write(project, "auth-flow", "two");
    expect(memory.index(project).entries).toHaveLength(1);
    expect(memory.read(project, "auth-flow")?.content).toBe("two");
  });

  it("keeps project and global stores separate", () => {
    memory.write(project, "stack", "project stack");
    memory.write(global, "stack", "global stack");
    expect(memory.read(project, "stack")?.content).toBe("project stack");
    expect(memory.read(global, "stack")?.content).toBe("global stack");
  });

  it("rebuilds MEMORY.md so the index on disk matches the topics", () => {
    memory.write(project, "release-process", "Ship on Thursdays after the checks pass.");
    const index = readFileSync(join(memory.dir(project), "MEMORY.md"), "utf8");
    expect(index).toContain("# Memory —");
    expect(index).toContain("release-process");
    expect(index).toContain("Ship on Thursdays");
  });

  it("appends timestamped lines to the daily log", () => {
    memory.appendLog(project, "fixed the flaky auth test");
    memory.appendLog(project, "cut the build time in half");
    const log = memory.read(project, "log");
    expect(log?.target).toBe("log");
    expect(log?.content).toContain("fixed the flaky auth test");
    expect(log?.content).toContain("cut the build time in half");
    expect(log?.content).toMatch(/-\s\d\d:\d\d:\d\d\s/);
  });

  it("searches across topics and ranks the dedicated note first", () => {
    memory.write(project, "caching", "We chose Redis over Memcached for TTL semantics.");
    memory.write(project, "auth-flow", "Redis also backs the session store, incidentally.");
    const hits = memory.search("redis", project, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].key).toBe("caching");
    expect(hits[0].excerpt).toContain("Redis");
  });

  it("recalls from the project store before the global one", () => {
    memory.write(global, "conventions", "Global: use tabs.");
    memory.write(project, "conventions", "This project uses two-space indent.");
    const hits = memory.recall("indent conventions", PROJECT, 5);
    expect(hits[0].scope).toBe("project");
  });

  it("forgets a topic", () => {
    memory.write(project, "temp", "throwaway");
    expect(memory.forget(project, "temp")).toBe(true);
    expect(memory.read(project, "temp")).toBeNull();
    expect(memory.forget(project, "temp")).toBe(false);
  });

  it("rejects an oversized topic instead of writing it", () => {
    expect(() => memory.write(project, "huge", "x".repeat(33_000))).toThrow(/exceed/);
    expect(memory.read(project, "huge")).toBeNull();
  });

  it("rejects empty writes", () => {
    expect(() => memory.write(project, "blank", "   ")).toThrow(/required/);
    expect(() => memory.appendLog(project, "")).toThrow(/required/);
  });

  it("renders a compact prompt block with the index and recalled passages", () => {
    memory.write(project, "test-setup", "Run vitest; the suite needs a local redis on 6379.");
    const block = memory.promptBlock(PROJECT, "how do I run the tests");
    expect(block).toContain("<project memory index>");
    expect(block).toContain("test-setup");
    expect(block).toContain("<recalled memory>");
    // Small enough to sit in every request without crowding the task out.
    expect(block.length).toBeLessThan(4_000);
  });

  it("returns an empty prompt block when there is nothing stored", () => {
    expect(memory.promptBlock(PROJECT, "anything")).toBe("");
  });

  it("isolates stores per project path", () => {
    const other = "/home/me/projects/other";
    memory.write(project, "stack", "acme stack");
    memory.write({ scope: "project", projectPath: other }, "stack", "other stack");
    expect(memory.read({ scope: "project", projectPath: other }, "stack")?.content).toBe("other stack");
    expect(memory.read(project, "stack")?.content).toBe("acme stack");
  });

  it("scrubs credential-shaped text before persisting", () => {
    memory.write(project, "keys", "the key is sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuv");
    const stored = readFileSync(join(memory.dir(project), "topics", "keys.md"), "utf8");
    expect(stored).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(stored).toContain("[redacted:api-key]");
    expect(stored).toContain("[redacted:github-token]");
    expect(memory.appendLog(project, "used AKIAABCDEFGHIJKLMNOP")).toBeTruthy();
    expect(readFileSync(join(memory.dir(project), "log", `${new Date().toISOString().slice(0, 10)}.md`), "utf8")).toContain(
      "[redacted:aws-key]",
    );
  });

  it("survives a brand-new service instance (memory is on disk, not in RAM)", () => {
    memory.write(project, "architecture", "Three packages behind one RPC contract.");
    const reopened = new MemoryService(dataDir);
    expect(reopened.read(project, "architecture")?.content).toContain("Three packages");
  });

  it("ignores a corrupt or unreadable store instead of throwing", () => {
    mkdirSync(join(dataDir, "memory", "global", "topics"), { recursive: true });
    writeFileSync(join(dataDir, "memory", "global", "topics", "broken.md"), "\u0000\u0001not really markdown");
    const fresh = new MemoryService(dataDir);
    expect(() => fresh.index(global)).not.toThrow();
  });
});

describe("redact", () => {
  it("removes common credential shapes", () => {
    expect(redact("key sk-abcdefghijklmnopqrstuv")).toContain("[redacted:api-key]");
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz")).toContain("[redacted:github-token]");
    expect(redact("aws AKIAABCDEFGHIJKLMNOP")).toContain("[redacted:aws-key]");
    expect(redact("https://user:supersecret@example.com/x")).toContain("[redacted:credentials-in-url]");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY-----")).toContain(
      "[redacted:private-key]",
    );
  });

  it("leaves ordinary prose alone", () => {
    const text = "Auth uses rotating refresh tokens; tests need a local redis.";
    expect(redact(text)).toBe(text);
  });
});

describe("scoreDocument", () => {
  const doc = (content: string, key = "note") => ({
    key,
    target: "topic" as const,
    scope: "project" as const,
    content,
    summary: content.split("\n")[0],
    updatedAt: Date.now(),
    size: content.length,
  });

  it("prefers a dedicated short note over a long one that merely mentions the term", () => {
    const short = scoreDocument("redis", doc("Redis is our cache."));
    const long = scoreDocument("redis", doc(`${"unrelated line\n".repeat(200)}we also touched redis once`));
    expect(short).toBeGreaterThan(long);
  });

  it("scores zero when nothing matches", () => {
    expect(scoreDocument("kubernetes", doc("Redis is our cache."))).toBe(0);
  });

  it("ignores stop words", () => {
    expect(scoreDocument("the and of", doc("Redis is our cache."))).toBe(0);
  });
});
