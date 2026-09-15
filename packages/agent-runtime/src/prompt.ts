import type { SkillRecord, TodoItem } from "@senastr/shared";

/**
 * System-prompt composition.
 *
 * Everything the model needs *before* it starts thinking, assembled from
 * parts that change at different rates. The ordering is deliberate: identity
 * and operating protocol first (stable), then the volatile, task-specific
 * layers (skills, memory, tasks, warnings) last, where they are closest to
 * the request and least likely to be truncated away.
 *
 * The whole block is rebuilt per step, which is what lets the runtime react
 * mid-turn: a completed todo, a new warning, or a memory note written two
 * steps ago all show up immediately.
 */

export interface SystemPromptParts {
  projectPath: string;
  base?: string;
  /** Skills available this turn: name + description only unless `always`. */
  skills?: SkillRecord[];
  /** Memory index + recalled passages, pre-rendered by the host. */
  memory?: string;
  /** The live task list. */
  todos?: TodoItem[];
  /** Runtime warnings (repeated calls, budget pressure, …). */
  warnings?: string[];
  /** Standing instructions + memory from the user (global + project). */
  standingInstructions?: string;
  planMode?: boolean;
  /** Skill bodies auto-loaded for this request (keyword match). */
  autoSkills?: SkillRecord[];
  /** Subagent run: the parent's brief and the reporting contract. */
  delegation?: {
    description?: string;
    systemExtra?: string;
    context?: string;
    readOnly?: boolean;
  };
}

const MAX_MANIFEST_DESCRIPTION = 180;

/**
 * Level 1 of progressive disclosure: one line per skill. At ~40 tokens each
 * a twenty-skill library costs less than a single inlined skill body.
 */
export function renderSkillManifests(skills: SkillRecord[]): string {
  if (!skills.length) return "";
  const lines = skills.map((skill) => {
    const description = (skill.description ?? "").replace(/\s+/g, " ").trim();
    const suffix = description ? `: ${truncate(description, MAX_MANIFEST_DESCRIPTION)}` : "";
    const origin = skill.source === "builtin" ? "" : ` [${skill.source ?? "user"}]`;
    return `- ${skill.id} — ${skill.name}${origin}${suffix}`;
  });
  return [
    "<available-skills>",
    ...lines,
    "</available-skills>",
    "",
    "Before starting work that matches a skill above, load it with use_skill { skill: \"<id>\" } and follow it. " +
      "Skill bodies are not loaded until you ask, so a match costs you nothing to check — and skipping a matching " +
      "skill is how avoidable mistakes get made. Load several when several apply.",
  ].join("\n");
}

/** `always: true` skills behave like standing instructions: always inlined. */
export function renderAlwaysSkills(skills: SkillRecord[]): string {
  const always = skills.filter((skill) => skill.always === true);
  if (!always.length) return("");
  return always
    .map((skill) =>
      [
        `<always-on-skill id="${skill.id}" name="${escapeAttr(skill.name)}">`,
        skill.description ? `Purpose: ${skill.description}` : "",
        skill.content.trim(),
        "</always-on-skill>",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

/**
 * Skills the runtime auto-activated for this request. Rendered in full (they
 * were matched for a reason) and marked so the model does not re-fetch them.
 */
export function renderAutoSkills(skills: SkillRecord[], allSkillIds: Set<string>): string {
  if (!skills.length) return "";
  const bodies = skills
    .map((skill) =>
      [
        `<auto-loaded-skill id="${skill.id}" name="${escapeAttr(skill.name)}">`,
        skill.description ? `Purpose: ${skill.description}` : "",
        skill.content.trim(),
        "</auto-loaded-skill>",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const others = [...allSkillIds].slice(0, 40).join(", ");
  return [
    "<active-skills>",
    "These skills were loaded automatically because they match the current request. Follow them.",
    bodies,
    "</active-skills>",
    others ? `Other skill ids you may still load: ${others}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderTodos(todos: TodoItem[]): string {
  if (!todos.length) return "";
  const icon = (status: TodoItem["status"]): string =>
    status === "completed" ? "x" : status === "in_progress" ? ">" : " ";
  const lines = todos.map(
    (todo) =>
      `- [${icon(todo.status)}] ${todo.id} ${todo.content}${todo.notes ? ` — ${todo.notes.replace(/\n/g, " ")}` : ""}`,
  );
  const done = todos.filter((t) => t.status === "completed").length;
  return [
    "<task-list>",
    `Progress: ${done}/${todos.length} completed`,
    ...lines,
    "</task-list>",
    "Replace the whole list with todo_write as it changes. Exactly one item is in_progress at a time.",
  ].join("\n");
}

export function renderWarnings(warnings: string[]): string {
  const clean = warnings.map((w) => w.trim()).filter(Boolean);
  if (!clean.length) return "";
  return ["<runtime-warnings>", ...clean.map((w) => `- ${w}`), "</runtime-warnings>"].join("\n");
}

export function composeSystemPrompt(parts: SystemPromptParts): string {
  const blocks: string[] = [parts.base?.trim() || defaultBase(parts.projectPath)];

  const alwaysSkills = renderAlwaysSkills(parts.skills ?? []);
  if (alwaysSkills) blocks.push(alwaysSkills);

  const autoSkills = renderAutoSkills(parts.autoSkills ?? [], new Set((parts.skills ?? []).map((s) => s.id)));
  if (autoSkills) blocks.push(autoSkills);

  if (parts.standingInstructions?.trim()) blocks.push(parts.standingInstructions.trim());

  const manifests = renderSkillManifests(parts.skills ?? []);
  if (manifests) blocks.push(manifests);

  if (parts.memory?.trim()) blocks.push(parts.memory.trim());
  if (parts.todos?.length) blocks.push(renderTodos(parts.todos));
  if (parts.warnings?.length) blocks.push(renderWarnings(parts.warnings));

  if (parts.delegation) {
    blocks.push(renderDelegation(parts.delegation));
  } else if (parts.planMode) {
    blocks.push(PLAN_MODE_BLOCK);
  }

  return blocks.filter(Boolean).join("\n\n");
}

export const PLAN_MODE_BLOCK = [
  "PLAN MODE: you are planning, not executing.",
  "- Investigate with read-only tools (read_file, glob, grep, code_intel, list_dir, web_fetch, memory).",
  "- Do NOT write files, run commands, or spawn subagents; those calls will be rejected.",
  "- You may call ask_user when a decision blocks the plan.",
  "- When the plan is complete, call submit_plan exactly once with the full plan.",
  "- After submitting, stop: the user will approve, reject, or ask for revisions.",
].join("\n");

function renderDelegation(delegation: NonNullable<SystemPromptParts["delegation"]>): string {
  const lines: string[] = [];
  if (delegation.systemExtra?.trim()) lines.push(delegation.systemExtra.trim());
  if (delegation.description) lines.push(`Your assignment: ${delegation.description}`);
  if (delegation.context?.trim()) {
    lines.push("", "<handoff-context>", delegation.context.trim(), "</handoff-context>");
  }
  if (delegation.readOnly) {
    lines.push(
      "",
      "READ-ONLY RUN: you may inspect anything, but write_file, edit_file, patch_file and run_command are unavailable. " +
        "Investigate and report.",
    );
  }
  lines.push("", DELEGATION_REPORT_CONTRACT);
  return lines.join("\n");
}

/**
 * The reporting contract every subagent signs. Structured reports are what
 * make delegation composable: the parent (and the next task in a batch) can
 * rely on the shape instead of parsing prose.
 */
export const DELEGATION_REPORT_CONTRACT = [
  "Reporting contract — end with a final message in exactly this shape:",
  "## Summary",
  "One paragraph: what you did and the outcome.",
  "## Changes",
  "Every file you created or modified as `path:line — what changed`. Empty if none.",
  "## Findings",
  "What you learned that the caller could not see: file references, root causes, constraints discovered.",
  "## Verification",
  "The commands you ran and their results, or an explicit statement that you did not verify and why.",
  "## Open questions",
  "Anything unresolved, plus the assumptions you made to proceed.",
  "",
  "Rules: stay inside your assignment; never touch files outside it without saying so; " +
    "you cannot ask the user anything, so state your assumptions instead of stalling; " +
    "be concise — the report is read by another model, not by a human browsing." ,
].join("\n");

function defaultBase(projectPath: string): string {
  return [
    `You are senastr, an elite local-first AI engineering agent. The current project is: ${projectPath}`,
    "",
    BASE_PROTOCOL,
  ].join("\n");
}

export const BASE_PROTOCOL = [
  "## Operating protocol",
  "",
  "1. **Understand before changing.** Locate the real code first (glob, grep, code_intel, read_file). " +
    "Never assume a file, symbol or behaviour exists — verify it. If the request is ambiguous at a decision point, " +
    "ask with `ask_user` rather than guessing.",
  "2. **Plan anything non-trivial.** For multi-step work call `todo_write` first and keep the list current: " +
    "one item `in_progress`, mark it `completed` the moment it is done.",
  "3. **Think when it is hard.** Before an irreversible or ambiguous step, record the reasoning with `think` " +
    "(options, evidence, risk, conclusion). Cheaper than three speculative tool calls.",
  "4. **Edit surgically.** Prefer `patch_file` (fuzzy search-and-replace) or `edit_file` (tag-guarded line ranges) " +
    "over rewriting files; use `write_file` only for new files. Match the existing style and conventions exactly.",
  "5. **Parallelise whatever is independent.** Issue several read-only calls in one block instead of one at a time.",
  "6. **Verify, then report.** After every meaningful change run `verify` (or the project's own command) and read " +
    "the exit codes. Never report success without evidence, and never weaken a test or type to make a check pass. " +
    "If a check cannot run, say plainly what is unverified.",
  "7. **Remember what was expensive to learn.** Use `memory` to persist durable decisions, conventions and root " +
    "causes, and search it before re-deriving something. Do not store secrets.",
  "8. **Delegate to keep context small.** Use `Task` / `batch_tasks` for broad exploration, independent " +
    "workstreams and independent review. Write a self-contained brief; verify what comes back.",
  "9. **Report honestly.** State what changed, what you verified (command + result), what you did not, and the " +
    "next step. A short accurate report beats a confident wrong one.",
  "",
  "## Tool-use discipline",
  "- Arguments must match the schema exactly. If a call is rejected, read the message — it names the parameter and " +
    "the fix — and re-issue it correctly. Do not repeat the same failing call.",
  "- If a tool call fails for the same reason twice, change the approach (re-read the file, use a different tool, " +
    "narrow the scope) instead of retrying the identical call.",
  "- Independent read-only calls go in the same block; dependent calls wait for their result.",
].join("\n");

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeAttr(value: string): string {
  return value.replace(/["<>]/g, "");
}
