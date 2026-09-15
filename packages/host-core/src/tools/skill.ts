import { BUILTIN_SKILLS, ErrorCodes, RpcError, type SkillRecord } from "@senastr/shared";
import { closest } from "../skill-files";
import type { SkillService } from "../skills";

/**
 * The `use_skill` tool — level 2 and 3 of progressive disclosure.
 *
 * The system prompt carries only each skill's name + description. When the
 * model decides a skill applies, this tool hands over its full body, and
 * optionally one bundled file (`references/`, `scripts/`, `assets/`).
 *
 * Keeping the body out of every request is the whole point: with a large
 * library, prompt-inlining everything would crowd out the task itself.
 */
export function useSkillTool(
  skills: SkillService,
  projectPath: string,
  args: Record<string, unknown>,
): string {
  const requested = typeof args.skill === "string" ? args.skill.trim() : "";
  const resource = typeof args.resource === "string" ? args.resource.trim() : "";

  if (!requested) {
    return listSkills(skills, projectPath);
  }

  const record = findSkill(skills, projectPath, requested);

  if (resource) {
    if (!record.dirPath) {
      throw new RpcError(
        ErrorCodes.HOST_ERROR,
        `skill "${record.name}" has no bundled files — it is a single-document skill`,
      );
    }
    const content = skills.readResource(record.id, resource, projectPath);
    return [
      `<skill-resource skill="${record.id}" path="${resource}">`,
      content,
      "</skill-resource>",
    ].join("\n");
  }

  const resources = skills.resources(record.id, projectPath) ?? [];
  const lines: string[] = [
    `<skill id="${record.id}" name="${record.name}">`,
    record.description ? `Purpose: ${record.description}` : "",
    "",
    record.content.trim(),
    "</skill>",
  ].filter(Boolean);

  if (resources.length) {
    lines.push(
      "",
      `Bundled resources (read one with use_skill { skill: "${record.id}", resource: "<path>" }):`,
      ...resources.map((r) => `  - ${r.path}${typeof r.size === "number" ? ` (${r.size} bytes)` : ""}`),
    );
  }
  if (record.dirPath) lines.push("", `Skill directory: ${record.dirPath}`);

  return lines.join("\n");
}

function findSkill(skills: SkillService, projectPath: string, requested: string): SkillRecord {
  const wanted = requested.toLowerCase();

  // Search the user's own skills first (stored + on-disk), then the library.
  const own = skills.list({ projectPath });
  const record =
    own.find((s) => s.id.toLowerCase() === wanted) ??
    own.find((s) => s.name.toLowerCase() === wanted) ??
    BUILTIN_SKILLS.find((s) => s.id.toLowerCase() === wanted) ??
    BUILTIN_SKILLS.find((s) => s.name.toLowerCase() === wanted);

  if (record) return record;

  // Fuzzy fallback: a typo or a stale id should still get a usable hint.
  const pool = [
    ...own.flatMap((s) => [s.id, s.name]),
    ...BUILTIN_SKILLS.flatMap((s) => [s.id, s.name]),
  ];
  const substring = pool.find((name) => {
    const lower = name.toLowerCase();
    return lower.includes(wanted) || wanted.includes(lower);
  });
  const suggestion = substring ?? closest(requested, pool);
  throw new RpcError(
    ErrorCodes.HOST_ERROR,
    `unknown skill: "${requested}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Call use_skill with no arguments to list the available skills.`,
  );
}

function listSkills(skills: SkillService, projectPath: string): string {
  const own = skills.list({ projectPath });
  const builtins = BUILTIN_SKILLS.filter(
    (b) => !own.some((s) => s.id === b.id || s.name.toLowerCase() === b.name.toLowerCase()),
  );
  const render = (s: SkillRecord, source: string): string =>
    `- ${s.id} — ${s.name} [${source}]${s.description ? `: ${s.description.slice(0, 160)}` : ""}`;

  const sections: string[] = [];
  if (own.length) {
    sections.push(`Skills in this workspace:\n${own.map((s) => render(s, (s.source ?? "user") as string)).join("\n")}`);
  }
  sections.push(`Bundled skills:\n${builtins.map((s) => render(s, "builtin")).join("\n")}`);
  sections.push("", 'Load one with use_skill { skill: "<id>" }.');
  return sections.join("\n\n");
}
