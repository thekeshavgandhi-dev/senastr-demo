import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcError } from "@senastr/shared";
import {
  contentTag,
  editFileTool,
  globToRegExp,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
} from "../src/tools/fs";

/** Fresh project fixture: src/app.ts, src/util.ts, docs/readme.md, noise. */
function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "senastr-tools-"));
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  mkdirSync(join(project, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(project, "src", "app.ts"), "export const app = 1;\nconsole.log(app);\n");
  writeFileSync(join(project, "src", "util.ts"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(project, "docs", "readme.md"), "# docs\n\napp notes\n");
  writeFileSync(join(project, "node_modules", "junk", "index.ts"), "export const app = 99;\n");
  return project;
}

/** Pull the tag out of a read_file header. */
function tagOf(output: string): string {
  const match = output.match(/#([0-9a-f]{8})/);
  if (!match) throw new Error(`no tag in output: ${output}`);
  return match[1];
}

describe("glob", () => {
  it("translates patterns including ** and ?", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/readme.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("readme.md")).toBe(true);
    expect(globToRegExp("*.ts").test("src/app.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
  });

  it("finds project files and skips heavy directories", () => {
    const project = makeProject();
    const out = globTool(project, { pattern: "**/*.ts" });
    expect(out).toContain("src/app.ts");
    expect(out).toContain("src/util.ts");
    expect(out).not.toContain("node_modules");
  });

  it("scopes the search to a subdirectory and reports empty results", () => {
    const project = makeProject();
    expect(globTool(project, { pattern: "*.ts", path: "docs" })).toContain("no files matched");
    expect(globTool(project, { pattern: "*.md", path: "docs" })).toContain("docs/readme.md");
  });

  it("refuses to escape the project root", () => {
    const project = makeProject();
    expect(() => globTool(project, { pattern: "*", path: ".." })).toThrow(RpcError);
  });

  it("caps the number of returned matches", () => {
    const project = mkdtempSync(join(tmpdir(), "senastr-glob-cap-"));
    for (let i = 0; i < 30; i++) writeFileSync(join(project, `f${i}.txt`), "x");
    const out = globTool(project, { pattern: "*.txt", max_results: 10 });
    expect(out).toContain("[truncated]");
    expect(out.split("\n").filter((l) => l.startsWith("f"))).toHaveLength(10);
  });
});

describe("grep", () => {
  it("returns path:line matches and respects include filters", () => {
    const project = makeProject();
    const all = grepTool(project, { pattern: "app" });
    expect(all).toContain("src/app.ts:1:");
    expect(all).not.toContain("node_modules");
    const onlyMd = grepTool(project, { pattern: "app", include: "**/*.md" });
    expect(onlyMd).toContain("docs/readme.md");
    expect(onlyMd).not.toContain("src/app.ts");
  });

  it("supports regular expressions and literal fallback", () => {
    const project = makeProject();
    expect(grepTool(project, { pattern: "export (const|function)" })).toContain("src/util.ts");
    // Unbalanced parenthesis is not a valid regex — treated as a literal search.
    expect(grepTool(project, { pattern: "add(a" })).toContain("src/util.ts:1:");
    expect(grepTool(project, { pattern: "add(a" })).toContain("— 1 match");
  });

  it("searches a single named file without walking siblings", () => {
    const project = makeProject();
    const out = grepTool(project, { pattern: "add", path: "src/util.ts" });
    expect(out).toContain("src/util.ts:1:");
    expect(out).not.toContain("app.ts");
  });

  it("caps results", () => {
    const project = mkdtempSync(join(tmpdir(), "senastr-grep-cap-"));
    writeFileSync(join(project, "many.txt"), Array.from({ length: 50 }, () => "hit").join("\n"));
    const out = grepTool(project, { pattern: "hit", max_results: 5 });
    const matches = out.split("\n").filter((l) => /^many\.txt:\d+: hit$/.test(l));
    expect(matches).toHaveLength(5);
    expect(out).toContain("[truncated]");
  });

  it("refuses to escape the project root", () => {
    const project = makeProject();
    expect(() => grepTool(project, { pattern: "root", path: "../../" })).toThrow(RpcError);
  });
});

describe("edit_file", () => {
  it("replaces a line range after verifying the tag", () => {
    const project = makeProject();
    const read = readFileTool(project, { path: "src/app.ts" });
    const tag = tagOf(read);
    const out = editFileTool(project, {
      path: "src/app.ts",
      tag,
      edits: [{ start_line: 2, end_line: 2, new_text: "console.log(app, 'edited');" }],
    });
    expect(out).toContain("edited src/app.ts");
    expect(out).toContain("new tag:");
    expect(readFileSync(join(project, "src", "app.ts"), "utf8")).toBe(
      "export const app = 1;\nconsole.log(app, 'edited');\n",
    );
  });

  it("rejects a stale tag so a changed file is never clobbered", () => {
    const project = makeProject();
    const tag = tagOf(readFileTool(project, { path: "src/app.ts" }));
    writeFileSync(join(project, "src", "app.ts"), "someone else edited this\n");
    expect(() =>
      editFileTool(project, {
        path: "src/app.ts",
        tag,
        edits: [{ start_line: 1, end_line: 1, new_text: "clobber" }],
      }),
    ).toThrow(/tag mismatch/);
    expect(readFileSync(join(project, "src", "app.ts"), "utf8")).toBe("someone else edited this\n");
  });

  it("applies multiple edits bottom-up so earlier line numbers stay valid", () => {
    const project = makeProject();
    const file = join(project, "src", "util.ts");
    writeFileSync(file, "one\ntwo\nthree\nfour\n");
    const tag = contentTag("one\ntwo\nthree\nfour\n");
    editFileTool(project, {
      path: "src/util.ts",
      tag,
      edits: [
        { start_line: 1, end_line: 1, new_text: "ONE" },
        { start_line: 4, end_line: 4, new_text: "FOUR\nFIVE" },
      ],
    });
    expect(readFileSync(file, "utf8")).toBe("ONE\ntwo\nthree\nFOUR\nFIVE\n");
  });

  it("inserts before a line when end_line = start_line - 1", () => {
    const project = makeProject();
    const file = join(project, "insert.txt");
    writeFileSync(file, "a\nb\n");
    editFileTool(project, {
      path: "insert.txt",
      tag: contentTag("a\nb\n"),
      edits: [{ start_line: 2, end_line: 1, new_text: "inserted" }],
    });
    expect(readFileSync(file, "utf8")).toBe("a\ninserted\nb\n");
  });

  it("deletes lines when new_text is empty", () => {
    const project = makeProject();
    const file = join(project, "del.txt");
    writeFileSync(file, "keep\ndrop\nkeep2\n");
    editFileTool(project, {
      path: "del.txt",
      tag: contentTag("keep\ndrop\nkeep2\n"),
      edits: [{ start_line: 2, end_line: 2, new_text: "" }],
    });
    expect(readFileSync(file, "utf8")).toBe("keep\nkeep2\n");
  });

  it("rejects out-of-range lines and malformed edits", () => {
    const project = makeProject();
    const tag = contentTag("a\nb\n");
    const file = join(project, "range.txt");
    writeFileSync(file, "a\nb\n");
    expect(() =>
      editFileTool(project, { path: "range.txt", tag, edits: [{ start_line: 9, end_line: 9, new_text: "x" }] }),
    ).toThrow(/out of range/);
    expect(() => editFileTool(project, { path: "range.txt", tag, edits: [] })).toThrow(/non-empty/);
    expect(() =>
      editFileTool(project, { path: "range.txt", tag, edits: [{ start_line: 1, end_line: 1 }] }),
    ).toThrow(/new_text/);
    expect(readFileSync(file, "utf8")).toBe("a\nb\n");
  });

  it("refuses to edit outside the project", () => {
    const project = makeProject();
    expect(() =>
      editFileTool(project, {
        path: "../escape.txt",
        tag: "deadbeef",
        edits: [{ start_line: 1, end_line: 1, new_text: "x" }],
      }),
    ).toThrow(RpcError);
  });

  it("keeps a missing trailing newline semantics stable", () => {
    const project = makeProject();
    const file = join(project, "no-newline.txt");
    writeFileSync(file, "a\nb");
    editFileTool(project, {
      path: "no-newline.txt",
      tag: contentTag("a\nb"),
      edits: [{ start_line: 2, end_line: 2, new_text: "B" }],
    });
    expect(readFileSync(file, "utf8")).toBe("a\nB");
  });
});

describe("read_file tags", () => {
  it("tags are stable for identical content and change with content", () => {
    const project = makeProject();
    const first = tagOf(readFileTool(project, { path: "src/app.ts" }));
    const second = tagOf(readFileTool(project, { path: "src/app.ts" }));
    expect(first).toBe(second);
    writeFileSync(join(project, "src", "app.ts"), "different\n");
    expect(tagOf(readFileTool(project, { path: "src/app.ts" }))).not.toBe(first);
  });
});

describe("project confinement through links", () => {
  it("refuses to read a file behind a symlink that leaves the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "senastr-outside-"));
    writeFileSync(join(outside, "secrets.txt"), "top secret");
    const project = mkdtempSync(join(tmpdir(), "senastr-proj-"));
    symlinkSync(join(outside, "secrets.txt"), join(project, "link.txt"));

    expect(() => readFileTool(project, { path: "link.txt" })).toThrow(/escapes the project root/);
  });

  it("refuses to write through a symlinked directory leaving the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "senastr-outside-"));
    const project = mkdtempSync(join(tmpdir(), "senastr-proj-"));
    symlinkSync(outside, join(project, "drop"));

    expect(() => writeFileTool(project, { path: "drop/owned.txt", content: "x" })).toThrow(
      /escapes the project root/,
    );
    expect(existsSync(join(outside, "owned.txt"))).toBe(false);
  });

  it("still allows symlinks that stay inside the project", () => {
    const project = mkdtempSync(join(tmpdir(), "senastr-proj-"));
    mkdirSync(join(project, "real"));
    writeFileSync(join(project, "real", "a.txt"), "inside");
    symlinkSync(join(project, "real"), join(project, "alias"));

    expect(readFileTool(project, { path: "alias/a.txt" })).toContain("inside");
  });
});
