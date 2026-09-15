# ADR 0008: Advanced agent capabilities — progressive skills, durable memory, verification and delegation

- Status: Accepted
- Date: 2026-09-15

## Context

The v0 loop (ADR 0002) can run a tool-calling conversation, but it struggles
with the things that make an agent *reliable* on real work:

1. **Prompt bloat.** Every skill body was injected into every system prompt. As
   the skill library grows, the context is consumed by instructions that are
   irrelevant to the current task.
2. **Amnesia.** Nothing persists between sessions. The agent re-derives the
   project's conventions, the user's preferences and past decisions every
   time, and repeats the same mistakes.
3. **Unverified completion.** The loop had no notion of "did this actually
   work?" — a turn could end after a write with no check ever run, and the
   agent would report success.
4. **Flat execution.** Every tool call was issued by one thread of reasoning,
   so independent reads were serialised and no work could be delegated.

Reference implementations (the [agentskills.io](https://agentskills.io) /
Claude Code `SKILL.md` standard, and Nous Research's
[Hermes Agent](https://github.com/NousResearch/hermes-agent)) converge on the
same four answers: progressive disclosure for skills, Markdown-backed durable
memory, an explicit verification gate, and isolated subagents.

## Decision

### 1. Skills use three-level progressive disclosure

- **Level 1 (discovery).** Each enabled skill contributes ~1 line
  (`- id — Name: description`) to the system prompt. Nothing else.
- **Level 2 (activation).** `use_skill` loads the full `SKILL.md` body for one
  skill into the transcript, once per turn. `always: true` skills are pinned
  and inlined automatically.
- **Level 3 (execution).** `read_skill_resource` streams bundled
  `scripts/`, `references/` and `assets/` on demand, with a per-turn budget
  (`MAX_ACTIVATED_SKILLS = 2`, `MAX_RESOURCE_READS = 6`) so a skill can't eat
  the context.

Skills are also matched *automatically* against the user's message by keyword
overlap (`autoActivateSkills`), so the model doesn't have to remember to ask.

### 2. Durable memory lives in Markdown under the project

`packages/host-core/src/memory.ts` keeps
`<project>/.senastr/memory/{MEMORY.md,topics/<topic>.md}` behind a single
`memory` tool with `write | append | read | list | search | delete` actions.
`MEMORY.md` is a curated index of pointers; topics hold the detail. A compact
`memoryPrompt` view is injected into every system prompt, and is
**failure-tolerant by design** — any error returns `""` rather than breaking
the turn. Search is BM25-ish keyword scoring (no embeddings, no new
dependencies), and writes are the agent's job, nudged by the protocol rather
than automated.

### 3. Verification is a gate, not a suggestion

`packages/host-core/src/tools/verify.ts` auto-detects a project's checks from
`package.json` scripts, lockfiles and tool configs (`packageManager`,
`detectChecks`), orders them cheap-first, dedupes, and runs them with a
bounded budget. The runtime tracks whether a turn wrote anything; if it did
and no check ran, the loop injects a nudge instead of ending the turn. The
nudge is **non-blocking and fires at most once** per turn
(`VERIFICATION_NUDGE_LIMIT = 1`), so a model that deliberately declines still
finishes.

### 4. Parallel execution and read-only subagents

- Independent read tools run concurrently up to `MAX_PARALLEL_TOOLS = 8`;
  writes stay strictly serialised and preserve transcript order.
- `Task` spawns a subagent with a reduced read-only tool set, its own step cap
  (`DELEGATION_MAX_STEPS = 16`) and a **reporting contract** (state files
  changed, what was verified, what remains, blockers). `batch_tasks` runs a
  wave of subagents with declared dependencies, executing independent waves in
  parallel and feeding prior results forward.
- Structured failure output (`observation / failure / next`) and a
  repeat-call detector (`REPEAT_WARN_AT = 2`, `REPEAT_STOP_AT = 4` →
  `stopReason: "stuck"`) stop loops that are going nowhere.

### 5. Bounded context under pressure

When the transcript exceeds the budget, dropped messages are **summarised into
the checkpoint** (a dedicated small-model request) instead of being replaced by
a placeholder; if summarisation fails, the placeholder is used. Either way the
turn continues.

### 6. Tool-call arguments are repaired, not rejected

`packages/agent-runtime/src/tool-validation.ts` coerces common model mistakes
(string→number/boolean/array/object, enum casing, `closest` name matches,
JSON-in-prose recovery, `_raw` salvage) before validation. Repairs are
reported to the model so it can correct the underlying habit.

## Rationale

- Progressive disclosure is the single biggest context win: a 30-skill library
  costs ~30 lines at discovery instead of ~30k tokens.
- Memory that the agent can read *and write* is what makes "orchestra memory"
  durable; Markdown keeps it inspectable and diffable by the user.
- Verification catches the most common real failure mode — reporting done
  before the change compiles — without ever trapping the turn in a loop.
- Read-only subagents make delegation safe: a subagent can explore freely but
  cannot mutate the repo.

## Consequences

- New protocol surface: `skill.use`, `skill.resource`, `memory.*`,
  `verify`-backed tool, `Task`, `batch_tasks`, `todo_write` on the host, plus
  `memoryPrompt` on the session view. All additions are backwards-compatible
  (old clients ignore unknown methods).
- More moving parts in the loop: activation budgets, the nudge counter, the
  repeat detector and compaction each add a branch that tests must cover.
- The `memory` tool is risk `write`, so it goes through the permission
  gateway like any other mutation.

## Verification

- `pnpm test` — 23 files / 348 tests (was 19 / 211); the new suites are
  `agent-advanced.test.ts` (33), `prompt.test.ts` (19),
  `tool-validation.test.ts` (24), `verify.test.ts` (13), `memory.test.ts`
  (23), `skill-files.test.ts` (23).
- `node scripts/verify-parity.mjs` — 67 pass / 0 fail / 7 gaps (was 66/1/7).
- `pnpm demo` exercises the headless path end-to-end.

## Alternatives

- **Always-inline skills** (the previous behaviour): simpler, but the context
  cost scales with the library, not the task.
- **Vector-backed recall** (memsearch / opencode-mem style): better fuzzy
  recall, but needs embeddings and a storage engine — rejected to keep
  host-core zero-dependency and local-first. Revisit if keyword recall proves
  insufficient.
- **Blocking verification** (refuse to end until checks pass): maximally
  correct, but unusable when a project has no checks or a broken baseline.
  Nudge-once is the compromise.
