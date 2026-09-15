import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultSkillRoots,
  discoverSkillFiles,
  listSkillResources,
  parseFrontmatter,
  readSkillDocument,
  readSkillResource,
  closest,
} from "../src/skill-files";
import { SkillService } from "../src/skills";
import { useSkillTool } from "../src/tools/skill";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "senastr-skills-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SKILL_MD = (name: string, description: string, body: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: ${description}${extra}\n---\n\n${body}\n`;

describe("frontmatter parsing", () => {
  it("splits metadata from the body", () => {
    const { frontmatter, body } = parseFrontmatter(SKILL_MD("demo", "does things", "# Demo\n\nDo it."));
    expect(frontmatter.name).toBe("demo");
    expect(frontmatter.description).toBe("does things");
    expect(body.trim()).toBe("# Demo\n\nDo it.");
  });

  it("handles quoted values, inline arrays and block lists", () => {
    const raw = [
      "---",
      'name: "Quoted Name"',
      "allowed-tools: [read_file, grep, run_command]",
      "triggers:",
      "  - fix the bug",
      "  - investigate",
      "always: true",
      "---",
      "body",
    ].join("\n");
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("Quoted Name");
    expect(frontmatter["allowed-tools"]).toBe("read_file, grep, run_command");
    expect(frontmatter.triggers).toBe("fix the bug, investigate");
    expect(frontmatter.always).toBe("true");
    expect(body.trim()).toBe("body");
  });

  it("returns the whole file when there is no frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("# Just markdown\n\nNo metadata.");
    expect(frontmatter).toEqual({});
    expect(body).toContain("# Just markdown");
  });

  it("treats an unterminated --- as content, not metadata", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: nope\n# heading\n");
    expect(frontmatter).toEqual({});
    expect(body).toContain("name: nope");
  });

  it("is case-insensitive and tolerates odd spacing", () => {
    const { frontmatter } = parseFrontmatter("---\nName:  Spaced   \nVersion: 1.2.3\n---\nx");
    expect(frontmatter.name).toBe("Spaced");
    expect(frontmatter.version).toBe("1.2.3");
  });
});

describe("skill discovery", () => {
  it("finds project skills in .senastr/skills and .claude/skills", () => {
    const project = tmp();
    mkdirSync(join(project, ".senastr", "skills", "release"), { recursive: true });
    writeFileSync(
      join(project, ".senastr", "skills", "release", "SKILL.md"),
      SKILL_MD("Release", "Cut a release safely", "Steps to cut a release."),
    );
    mkdirSync(join(project, ".claude", "skills", "debugging"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "skills", "debugging", "SKILL.md"),
      SKILL_MD("Debugging", "Debug systematically", "Bisect first."),
    );

    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: project, dataDir: tmp(), homeDir: tmp() }));
    const ids = found.map((s) => s.id);
    expect(ids).toContain("release");
    expect(ids).toContain("debugging");
    expect(found.every((s) => s.level === "project")).toBe(true);
    expect(found.every((s) => s.source === "project-file")).toBe(true);
  });

  it("finds global skills under the data dir", () => {
    const dataDir = tmp();
    mkdirSync(join(dataDir, "skills", "house-style"), { recursive: true });
    writeFileSync(
      join(dataDir, "skills", "house-style", "SKILL.md"),
      SKILL_MD("House Style", "How we write code here", "Two-space indent."),
    );
    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: null, dataDir, homeDir: tmp() }));
    expect(found.map((s) => s.id)).toContain("house-style");
    expect(found[0].source).toBe("global-file");
  });

  it("lets a project skill shadow a global one with the same id", () => {
    const dataDir = tmp();
    const project = tmp();
    mkdirSync(join(dataDir, "skills", "review"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "review", "SKILL.md"), SKILL_MD("Review", "global", "global body"));
    mkdirSync(join(project, ".senastr", "skills", "review"), { recursive: true });
    writeFileSync(join(project, ".senastr", "skills", "review", "SKILL.md"), SKILL_MD("Review", "project", "project body"));

    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: project, dataDir, homeDir: tmp() }));
    const matches = found.filter((s) => s.id === "review");
    expect(matches).toHaveLength(1);
    expect(matches[0].content).toBe("project body");
  });

  it("reads a single-file skill (<name>/<name>.md) and loose markdown files", () => {
    const project = tmp();
    mkdirSync(join(project, ".senastr", "skills", "single"), { recursive: true });
    writeFileSync(join(project, ".senastr", "skills", "single", "single.md"), SKILL_MD("Single", "one file", "body"));
    mkdirSync(join(project, ".senastr", "skills"), { recursive: true });
    writeFileSync(join(project, ".senastr", "skills", "loose.md"), SKILL_MD("Loose", "no folder", "loose body"));

    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: project, dataDir: tmp(), homeDir: tmp() }));
    expect(found.map((s) => s.id)).toEqual(expect.arrayContaining(["single", "loose"]));
  });

  it("lists bundled resources and skips build directories", () => {
    const project = tmp();
    const dir = join(project, ".senastr", "skills", "packed");
    mkdirSync(join(dir, "references"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD("Packed", "has files", "see references"));
    writeFileSync(join(dir, "references", "api.md"), "# api");
    writeFileSync(join(dir, "scripts", "check.sh"), "#!/bin/sh");
    writeFileSync(join(dir, "node_modules", "junk.md"), "junk");

    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: project, dataDir: tmp(), homeDir: tmp() }));
    const packed = found.find((s) => s.id === "packed")!;
    const paths = (packed.resources ?? []).map((r) => r.path);
    expect(paths).toContain("references/api.md");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("parses always, triggers and allowed-tools", () => {
    const project = tmp();
    const dir = join(project, ".senastr", "skills", "strict");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      SKILL_MD("Strict", "always applies", "be strict", "\nalways: true\ntriggers: [review, audit]\nallowed-tools: [read_file, grep]"),
    );
    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: project, dataDir: tmp(), homeDir: tmp() }));
    const strict = found.find((s) => s.id === "strict")!;
    expect(strict.always).toBe(true);
    expect(strict.triggers).toEqual(["review", "audit"]);
    expect(strict.allowedTools).toEqual(["read_file", "grep"]);
  });

  it("derives the description from the body when frontmatter omits it", () => {
    const project = tmp();
    const dir = join(project, ".senastr", "skills", "nodesc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: NoDesc\n---\n\n# Fallback heading\n\nBody.");
    const found = discoverSkillFiles(defaultSkillRoots({ projectPath: project, dataDir: tmp(), homeDir: tmp() }));
    expect(found[0].description).toBe("Fallback heading");
  });

  it("refuses to read a resource outside the skill directory", () => {
    const project = tmp();
    const dir = join(project, ".senastr", "skills", "safe");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD("Safe", "sandboxed", "body"));
    writeFileSync(join(dir, "references", "ok.md"), "fine");
    writeFileSync(join(project, "secret.txt"), "nope");

    const record = readSkillDocument(join(dir, "SKILL.md"), { dir: project, level: "project", origin: "test", projectPath: project }, "safe")!;
    expect(() =>
      readSkillResource({ dirPath: dir, resources: listSkillResources(dir, join(dir, "SKILL.md")) }, "../secret.txt"),
    ).toThrow(/no such resource|escapes/);
    expect(record.id).toBe("safe");
  });

  it("suggests the closest resource name on a miss", () => {
    const project = tmp();
    const dir = join(project, ".senastr", "skills", "suggest");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD("Suggest", "suggests", "body"));
    writeFileSync(join(dir, "references", "api-guide.md"), "# api");
    const resources = listSkillResources(dir, join(dir, "SKILL.md"));
    expect(() => readSkillResource({ dirPath: dir, resources }, "references/api.md")).toThrow(/api-guide/);
  });
});

describe("SkillService", () => {
  function setup() {
    const dataDir = tmp();
    const project = tmp();
    return { dataDir, project, skills: new SkillService(dataDir, tmp()) };
  }

  it("merges stored, file and builtin skills", () => {
    const { dataDir, project, skills } = setup();
    mkdirSync(join(project, ".senastr", "skills", "from-disk"), { recursive: true });
    writeFileSync(
      join(project, ".senastr", "skills", "from-disk", "SKILL.md"),
      SKILL_MD("From Disk", "a file skill", "file body"),
    );
    skills.set({ name: "Stored", description: "a stored skill", content: "stored body", level: "global" });

    const all = skills.list({ projectPath: project });
    expect(all.map((s) => s.id)).toContain("from-disk");
    expect(all.map((s) => s.id)).toContain("stored");
    expect(skills.getById("from-disk", project)?.content).toBe("file body");
    // Builtins resolve too, so use_skill can load them.
    expect(skills.getById("systematic-debugging")?.id).toBe("systematic-debugging");
  });

  it("picks up a SKILL.md dropped in mid-session without a restart", () => {
    const { project, skills } = setup();
    expect(skills.list({ projectPath: project }).map((s) => s.id)).not.toContain("late");
    mkdirSync(join(project, ".senastr", "skills", "late"), { recursive: true });
    writeFileSync(join(project, ".senastr", "skills", "late", "SKILL.md"), SKILL_MD("Late", "added later", "late body"));
    expect(skills.list({ projectPath: project }).map((s) => s.id)).toContain("late");
  });

  it("disables a file skill through an override that survives a new instance", async () => {
    const { dataDir, project, skills } = setup();
    mkdirSync(join(project, ".senastr", "skills", "toggle"), { recursive: true });
    writeFileSync(join(project, ".senastr", "skills", "toggle", "SKILL.md"), SKILL_MD("Toggle", "can be turned off", "body"));

    skills.setEnabled("toggle", false, { projectPath: project });
    await skills.flush();
    expect(skills.active(project).map((s) => s.id)).not.toContain("toggle");
    expect(new SkillService(dataDir, tmp()).active(project).map((s) => s.id)).not.toContain("toggle");

    skills.setEnabled("toggle", true, { projectPath: project });
    expect(skills.active(project).map((s) => s.id)).toContain("toggle");
  });

  it("refuses to delete a file skill and says where it lives", () => {
    const { project, skills } = setup();
    mkdirSync(join(project, ".senastr", "skills", "pinned"), { recursive: true });
    writeFileSync(join(project, ".senastr", "skills", "pinned", "SKILL.md"), SKILL_MD("Pinned", "on disk", "body"));
    expect(() => skills.delete("pinned", { projectPath: project })).toThrow(/file-backed/);
    expect(existsSync(join(project, ".senastr", "skills", "pinned", "SKILL.md"))).toBe(true);
  });
});

describe("use_skill tool", () => {
  function setup() {
    const dataDir = tmp();
    const project = tmp();
    const skills = new SkillService(dataDir, tmp());
    return { project, skills };
  }

  it("lists available skills when called with no arguments", () => {
    const { project, skills } = setup();
    const out = useSkillTool(skills, project, {});
    expect(out).toContain("Bundled skills:");
    expect(out).toContain("systematic-debugging");
    expect(out).toContain("use_skill");
  });

  it("loads a builtin skill body and says how to read its resources", () => {
    const { project, skills } = setup();
    const out = useSkillTool(skills, project, { skill: "verification-loop" });
    expect(out).toContain('<skill id="verification-loop"');
    expect(out).toContain("A change is done when it is");
  });

  it("loads a file skill body and lists its bundled files", () => {
    const { project, skills } = setup();
    const dir = join(project, ".senastr", "skills", "packed");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD("Packed", "has references", "read the reference"));
    writeFileSync(join(dir, "references", "api.md"), "# The API surface");

    const body = useSkillTool(skills, project, { skill: "packed" });
    expect(body).toContain("read the reference");
    expect(body).toContain("references/api.md");

    const resource = useSkillTool(skills, project, { skill: "packed", resource: "references/api.md" });
    expect(resource).toContain("# The API surface");
  });

  it("suggests a near miss instead of failing obscurely", () => {
    const { project, skills } = setup();
    expect(() => useSkillTool(skills, project, { skill: "systematic-debuging" })).toThrow(/Did you mean/);
  });
});

describe("closest", () => {
  it("finds the nearest name within the distance cap", () => {
    expect(closest("read_fil", ["read_file", "write_file", "glob"])).toBe("read_file");
    expect(closest("completely-different", ["read_file", "glob"])).toBeUndefined();
  });
});
