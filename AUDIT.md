# senastr — Full-App Audit Report

**Scope:** every UI control → backend wiring, bug hunt, and a comprehensive automated test pass.
**Date:** 2026-09-14 · **Branch:** `arena/01a09d67-senastr-demo`

---

## 1. Verdict

> **No frontend-only stubs found.** Every one of the **63 preload IPC channels** is matched 1:1
> by a `ipcMain.handle` in the main process, and each of those forwards to a real host-core
> `Methods.*` implementation (sessions, providers, models, skills, subagents, MCP, scheduled
> tasks, review, project context/git, permissions, plugin install/run, notifications, file
> dialogs). Non-channel surfaces (open-external, clipboard, window controls) are wired natively.

**Automated verification:** `pnpm typecheck` ✅ · `pnpm test` **12 files / 147 tests, all passing** ✅ · `pnpm demo` (headless e2e against a real host-core sidecar) ✅

---

## 2. Wiring audit — UI control → IPC → backend

The renderer only ever talks to the backend through the typed `window.senastr` bridge
(`preload/index.ts`). A static cross-check (preload channels ↔ `ipcMain.handle` registrations ↔
`Methods` enum, multiline-tolerant) reports **63/63 both directions**, no orphans on either side.

| UI surface | Controls | Backend path | Status |
|---|---|---|---|
| Sidebar | new task, open project, filter, sort, per-session menu (rename/pin/fork/archive/delete), per-project menu (new task/rename/pin), collapse | `project.openDirectory`, `session.*`, localStorage prefs | ✅ |
| Conversation topbar | model menu, mode menu (incl. permission modes + standing grants), status/task label | `provider.list`, `session.setMode`, `permission.*` | ✅ |
| Composer | send, queue-when-busy (+remove), stop, enhance, attach files/paste, `@`-file autocomplete, plan approve/reject | `chat.send`, `chat.stop`, `enhance`, `file.pick` | ✅ |
| Permission gateway | Allow/Deny/Always/Never dialog with queue badge | `permission.respond`, `permission.list` | ✅ (bug 3 fixed) |
| Ask dialog | question/option answering | `chat.resolveAsk` | ✅ |
| Plan dialog | approve (→ build), reject (→ back to plan), request changes | `session.setMode` + `chat.send` | ✅ (bug 5 fixed) |
| Search (Ctrl+K) | fuzzy actions + sessions + settings row | local index + `session.list` | ✅ (bug 2 fixed) |
| Settings | models (add/test/discover/delete), skills, subagents, MCP (add/test), scheduled (CRUD/enable/run/history), instructions | `provider.*`, `skill.*`, `subagent.*`, `mcp.*`, `scheduled.*` | ✅ (bug 1 fixed) |
| Work panel | transcript/review/files/details/activity tabs; review rollback/purge; fork/archive | `review.*`, `session.fork`, delegations, notifications | ✅ |
| Notifications | bell, mark read, clear, deep-links | `notification.list`, `notification.markRead` | ✅ |
| Misc | external links, clipboard, onboarding checklist, toasts, keyboard shortcuts | `shell.openExternal`, navigator.clipboard | ✅ |

**Safety rails verified in the backend** (all real implementations, not UI theater):
`read_file`/`write_file` confined to the project root (`safeJoin` → `PATH_ESCAPES_PROJECT`);
command runner with per-command timeout, output caps and POSIX group kill; plugin URLs
allow-listed to github/gitlab/bitbucket/git.sr.ht; secrets masked host-side (`••••••`);
permission auto-deny after 120 s; review snapshots capped (200 k chars / 200 per session);
scheduler ≤2 tasks per 30 s tick with manual-trigger double-fire guard.

---

## 3. Bugs found & fixed (product code)

| # | Severity | Where | Bug | Fix |
|---|---|---|---|---|
| 1 | **High** | `host-core/scheduled.ts` | `recordRun` truncated run history — repeated scheduler writes erased the history the Settings UI shows | preserve and re-persist prior runs |
| 2 | **High** | `renderer/SearchDialog.tsx` | the trailing "Open settings" row was unreachable by keyboard (ArrowDown cycled only over real rows) and dead on click | include it in navigation/cycling and activation |
| 3 | **High** | `useSenastr.ts` + `PermissionDialog.tsx` | a second concurrent permission request **replaced** the pending one (lost decision path); no indication more were waiting | FIFO permission queue, `respondPermission` pops the head, dialog shows "· N waiting" |
| 4 | **Medium** | `main/index.ts` | (a) `window.open`/navigation could escape the Electron sandbox to arbitrary origins; (b) manual "Run now" on a scheduled task could double-fire alongside the scheduler tick | origin allow-list for window-open/navigate; `manuallyRunningTasks` set + trigger short-circuit/scheduler skip |
| 5 | **High** | `useSenastr.ts` | plan-mode "Request changes" resent the prompt with the **stale session pref mode**, silently flipping the session plan→build | `flushQueueSend` gained `modeOverride`; approve → `"build"`, reject → `"plan"` explicitly |

All fixes are covered by the new test suite (see §4).

---

## 4. Test pass ("testing team")

New infrastructure so the **real App** can be tested end-to-end without Electron:

- `apps/desktop/src/renderer/test/fake-backend.ts` — full in-memory `SenastrApi`
  (sessions, providers, permissions, scheduled, review, notifications, plugin sandbox, git/PR
  fixtures) with event emission and call recording; mirrors the wire behavior of the real host.
- `apps/desktop/src/renderer/test/app-harness.tsx` — mounts the actual `App` over a proxy of the
  IPC bridge, with provider/session seeding helpers.
- `apps/desktop/src/renderer/components/AppShell.test.tsx` — **48 full-shell tests** in
  8 suites covering every control surface: onboarding, no-provider state, composer (send, queue +
  auto-flush, remove-from-queue, stop, enhance, attach, `@`-autocomplete), transcript rendering,
  live tool progress, error layer (Settings deep-link / Retry / dismiss), permission gateway
  (dialog, deny, always-grant, auto mode, accept-edits, simultaneous queue), ask dialog, plan
  flow (approve → build mode, request-changes → stays plan — regression for bug 5), session
  lifecycle (rename/AI title, pin, fork, archive/restore, delete), sidebar (filter, sort,
  collapse, project menu), work panel (toggle, review rollback/purge, files, details, activity +
  notification deep-links), search (query, actions, exact keyboard nav — regression for bug 2),
  settings view, toasts, and shortcuts (Ctrl+J/K/B/,/Shift+O, Escape).

**Totals: 12 test files / 147 tests — all green** (99 pre-existing across protocol, host-core,
agent loop, resilient transport, rpc-client; +48 new full-app tests). `pnpm typecheck` clean;
`pnpm demo` (spawns the real sidecar and exercises protocol, tools, permissions, scheduled,
review, plugins) passes.

Not executable in this sandbox: the Electron binary itself (no network access to download it).
The vitest/jsdom suite + headless demo cover the app logic and the host protocol instead.

---

## 5. Observations (no action required)

- Composer attachments are paths picked via the native dialog; the model reads them through the
  confined `read_file`, so reads outside the project root are rejected by design.
- `agent.ts` loop reviewed in full: abort propagation, plan-mode read-only enforcement (server
  side, not just prompt-side), delegation step/report limits, ask-resolution cleanup on stop.
- Host scheduler/permission/review/plugin limits (§2) are all enforced in the backend, not the UI.

---

## Addendum — button-by-button dead-control sweep (round 2)

After the initial audit, a mechanical sweep of **every** `<button>`/`TooltipButton` in the
renderer (script-checked for a missing `onClick`, no-op handlers, always-disabled states, and
silent catch blocks on click paths) found and fixed:

| Where | Problem | Fix |
|---|---|---|
| Settings → Scheduled | "All" segment button had **no onClick** (fake tab) | now a real **All / Global / Project** filter (tasks carry `projectPath`) |
| Settings → Extensions | "Installed" segment button had **no onClick** (single-scope fake tab) | rendered as a static label — plugins are app-level, there is nothing to filter |
| Whole app in a non-Electron context | `lib/api.ts` bound `window.senastr` unguarded: without the preload bridge (plain browser load, broken preload) **every** button failed silently or threw opaque `TypeError`s | `hasBridge()` gate: the app now renders a **"backend is not connected"** screen (`role=alert`, with `pnpm dev` instructions) instead of a dead UI, and any stray API call rejects with that same actionable message |

Verified after the sweep: **13 files / 151 tests green**, `pnpm typecheck` clean, `pnpm demo` passing.
Everything else checked out: no no-op handlers, no always-disabled controls, all settings pages
surface failures as toasts, chat markdown links open in the system browser via the main-process
guard, and the composer swaps to guidance buttons when no provider/project is configured.
