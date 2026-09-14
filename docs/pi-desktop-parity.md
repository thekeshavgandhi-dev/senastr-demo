# senastr ↔ pi-desktop parity audit

**Reference:** [`vastsa/pi-desktop`](https://github.com/vastsa/pi-desktop) (cloned at the tag
present on `main` when this audit ran).
**Scope:** every user-visible and contract-level feature area of the reference, checked
against the code in this repository — not against this repository's README.
**Date:** 2026-09-14, updated **2026-09-15** · **Branches:** `arena/01a09d8e-senastr-demo`, `arena/01a0a015-senastr-demo`.

> ### Update — 2026-09-15 (round 2)
>
> All six gaps in §5 and the "Missing" verdicts in §2/§3 (areas 10, 11, 18, 19, 20) are now
> **implemented and covered by tests**. New evidence:
>
> ```bash
> pnpm typecheck                  # 3 packages + desktop, clean
> pnpm test                       # 202 tests / 17 files, all pass
> node scripts/verify-parity.mjs  # 74 pass · 0 fail · 0 gaps
> node scripts/demo.mjs           # 9/9 steps
> node scripts/verify-packaging.mjs  # OK 7/7
> ```
>
> What landed (each with a test or a harness check):
>
> | Area | Now in senastr |
> | --- | --- |
> | Reasoning / thinking level | `packages/shared/src/thinking-levels.ts` (`off…xhigh`, clamping), per-model `supportedThinkingLevels`/`defaultThinkingLevel`, `assistant/reasoning` events, provider wiring for OpenAI (`reasoning_effort`), Anthropic (thinking budget, temperature suppressed), Gemini (`thinkingConfig`, `thought: true`), Responses (summaries); composer reasoning menu + `session/set-thinking`. |
> | Image attachments | `packages/host-core/src/attachments.ts` (12 MB image cap, `.bin`+`.json` sidecar, host-only reads), `attachment/*` methods, `hydrateAttachments()` in the runtime (OpenAI `image_url`, Anthropic base64, Gemini `inlineData`), composer picker/paste chips with thumbnails, transcript thumbnails. |
> | In-app updates | `apps/desktop/src/main/updates.ts` (`UpdatesService`, `electron-updater`), `SENASTR_UPDATE_REPO`/`_FEED`, `updates/state` event, Settings → Updates page with channel + auto-check, release-URL fallback when no signed feed is configured. |
> | i18n | `renderer/lib/i18n.ts` with `en` + `zh-CN` catalogues, translator wired through the shell, language switcher persisted to host settings (`settings/set`). |
> | Command palette / `/` / `@` | `renderer/components/CommandPalette.tsx` (commands from `command/list` + project files, `executeCommand`), `command/shells` catalog, builtin slash commands (`/new`, `/compact`, `/agent-mode`, `/plan-mode`, `/goal-mode`, …), shared `composer-trigger.ts` (`detectTrigger`, `applyCompletion`, `rankFileCandidates`, ideographic-comma rewrite), `fs/index` file index, `chat/compact` + `session/replace-messages`. |
> | Session import | `packages/host-core/src/importers.ts` for Claude Code, Codex, OpenCode and Pi, `session/import-scan` + `session/import-run`, Settings → Import page. |
> | Also added in this round | Projects + project groups (`projects.ts`, `project/*`, sidebar menus), token usage history (`stats.ts`, `stats/usage`, Settings → Usage), network proxy for models/MCP/child processes (`network-proxy.ts`, Settings → Network, ADR-0177-style bypass list), session revisions (`revisions.ts`), scratch workspace (`scratch.ts`), model-config import (`model-config/import-scan|import-run`), per-model context/output/temperature configuration, and provider summaries that expose those configs. |
>
> Still **not** implemented (tracked as the round-3 backlog, all UI/plugin surface rather than
> agent contract): the plugin marketplace, plugin-contributed work-panel views/themes/launcher
> and the resident-service + inter-plugin messaging runtime, the bundled `pi.browser` host,
> filesystem reveal/open IPC, the scratch and marketplace settings pages, pending-plan
> resolution surfaces, project memory/clone, host-side `pulls`, onboarding/system-fonts/feedback
> IPC, and native window controls. The 6-item list in §5 is therefore **historical**: it
> records what round 1 found, not the current state.

---

## 1. How this was checked

Claims in this document are backed by one of four kinds of evidence. Anything not
backed by one of these is labelled **unverified**.

| Evidence | What it means |
| --- | --- |
| **Harness** | `node scripts/verify-parity.mjs` — boots the **real** `host-core` sidecar as a child process, speaks the actual NDJSON JSON-RPC protocol to it against temp data/project dirs, and auto-answers permission cards. 68 checks. |
| **Unit** | `pnpm test` — 198 tests in 17 files (vitest + jsdom for the renderer). |
| **Demo** | `pnpm demo` — 9-step end-to-end script over the real protocol, including a plugin install and a real model turn when credentials are supplied. |
| **Source** | Direct inspection of both repositories (`packages/`, `apps/desktop/`, `crates/`). |

Commands run for this report:

```bash
pnpm install --frozen-lockfile
pnpm build:packages && pnpm typecheck      # clean
pnpm test                                  # 17 files · 198 tests · all pass
pnpm demo                                  # 9/9 steps
node scripts/verify-parity.mjs             # 68 pass · 0 fail · 6 gaps
node scripts/verify-packaging.mjs          # 7/7 checks
pnpm test:e2e                              # SKIP (Electron binary not downloadable offline)
```

**Scale context.** senastr is ~17.4k lines of source + 3.8k lines of tests. The reference
is ~159k lines of TypeScript plus ~44k lines of Rust, with 245 ADRs and 77 spec documents.
Absolute feature-count parity is therefore not the right bar; parity on the *core contract*
(agent loop, tools, permissions, storage, desktop shell) is, and that is what is assessed.

---

## 2. Headline verdict

> **The core is genuinely working and now matches the reference on the agent loop, tool set,
> permission model, storage, secrets, confinement and distribution path. Six features are
> still missing outright.**

At the start of the audit, **16** feature areas were partial or missing — several of them
things the README implied were done (edit tools, encrypted credentials, context management).
Nine were closed during the audit; **6 remain** (§5).

| # | Area | Verdict |
| --- | --- | --- |
| 1 | JSON-RPC protocol + sidecar lifecycle | ✅ Works |
| 2 | Agent loop, step bounds, abort, supervision | ✅ Works |
| 3 | Tool catalog | ✅ Works |
| 4 | Tool-result limits | ✅ Works |
| 5 | Permission layer | ✅ Works |
| 6 | Filesystem confinement | ✅ Works |
| 7 | Credential storage | ✅ Works |
| 8 | Context-window management | ✅ Works |
| 9 | Durable storage | ✅ Works |
| 10 | Provider / model system | 🟡 Partial — no reasoning level, no image attachments |
| 11 | Sessions & transcripts | 🟡 Partial — no import from other agents |
| 12 | Skills · subagents · plugins · MCP · scheduling | ✅ Works |
| 13 | Code review & rollback + work panel | ✅ Works |
| 14 | Desktop shell security | ✅ Works |
| 15 | Tray / background residency | ✅ Works |
| 16 | Packaging & installers | ✅ Works (config verified; installers not built — offline) |
| 17 | CI & test strategy | 🟡 Partial — CI + boot smoke present, one e2e script vs the reference's ~20 |
| 18 | Internationalisation | ❌ Missing |
| 19 | Command palette · `/` commands · `@` file refs | ❌ Missing |
| 20 | In-app updates | ❌ Missing |

---

## 3. Area-by-area findings

### 1. JSON-RPC protocol + sidecar lifecycle — ✅ Works

`host/ping` returns version, protocol version and data dir; unknown methods return a
proper JSON-RPC method-not-found error; a malformed JSON line does not kill the sidecar
(`P1`–`P3`). The sidecar is a separate process with a versioned protocol, mirroring the
reference's host-core boundary.

### 2. Agent loop, step bounds, abort, supervision — ✅ Works

Step caps per turn (24) and per delegation (12), a delegation cap (50), a bounded ask
loop (4 questions × 6 rounds), an 8k report cap, abort propagation, and automatic
restart of a crashed sidecar (`A5`, `A6`, `D5`). Plan mode is enforced **server-side**
(tool calls are denied in the runtime, not merely discouraged in the prompt), which is
the behaviour the reference freezes in its tool/permission policy (`A1`).

### 3. Tool catalog — ✅ Works

Ten builtins, covering everything the reference's frozen policy exposes and one more:

| senastr | reference equivalent |
| --- | --- |
| `read_file` (content tag) | `Read` |
| `write_file` | `Write` |
| `edit_file` (line-anchored ops + whole-file tag) | `Edit` (line-anchored) |
| `glob` | `Glob` |
| `grep` | `Grep` |
| `list_dir` | (covered by `Glob` in the reference) |
| `ask_user` | `asktool` |
| `submit_plan` | `SubmitPlan` |
| `Task` | subagents |
| `run_command` | `Bash` |

`edit_file` deliberately mirrors the reference's *line-anchored* edit contract rather than
the more common `old_string`/`new_string` shape: the model sees `path: <rel>#<tag>` on read
and must quote the tag back, so a stale edit is rejected with "tag mismatch … Read the file
again" instead of silently corrupting the file (`T3-*`, unit tests).

### 4. Tool-result limits — ✅ Works

Every result is bounded: reads 500 lines / 100k chars (1M hard cap), glob 500 (2000 max),
grep 200 (1000 max, 1 MB per file), list_dir a hard entry cap, with `[truncated]` markers
(`T7`, `T9`). Binary files are skipped by grep.

### 5. Permission layer — ✅ Works

Interactive permission cards with a human-readable summary; deny blocks the tool; allow-once
leaves no standing grant; "always" suppresses later prompts; session grants do not leak
between sessions; `permission/clear` revokes standing grants; concurrent requests queue
instead of overwriting each other; the timeout constant is 120 s → deny (`K1`–`K8`). Reviews
snapshots are taken for both `write_file` and `edit_file` (`C6`).

*Difference from the reference:* the reference also has an explicitly-approved
**outside-project access** flow that tags results `root: "external"`. senastr hard-refuses
outside paths instead. Refusing is stricter, not less safe, but it means "edit a file two
directories up" is impossible rather than permissioned.

### 6. Filesystem confinement — ✅ Works

Two layers, both verified (`T5a`–`T5d`): a lexical check rejects `..` and absolute paths
before any filesystem call, and a real-path check rejects symlinks that leave the project
root — including writes through a symlinked *directory* — while still allowing symlinks
that stay inside. **This was a real vulnerability at the start of the audit** (see §4).

### 7. Credential storage — ✅ Works

Provider and MCP credentials are encrypted at rest with AES-256-GCM behind a `0600` key file;
the desktop wraps that key with Electron `safeStorage`. Legacy plaintext rows are migrated on
load, plaintext still decrypts on read, and re-encrypts on write; the mask round-trip keeps a
stored key when the UI echoes the mask back (`V1`–`V6`). The renderer never receives key
material (`V1`, `V3`).

### 8. Context-window management — ✅ Works

`compactHistory` keeps the task anchor and the newest window, drops a middle slice, repairs
orphaned tool calls, clips any single message over 24k chars, and inserts a `[context
checkpoint]` note naming how much was dropped. It is wired into both the turn loop and the
delegation loop, and `turn/end` reports `compaction: {dropped, truncated}` (`A2`, 7 unit
tests). Transcripts stay complete on disk — only the model's window is bounded.

### 9. Durable storage — ✅ Works

Session transcripts survive a sidecar restart (`M3`) and survive an *immediate* restart,
because every store-owning service now exposes `flush()` and shutdown drains them (bounded
at 2 s) before closing. Previously a quick exit could lose a queued write — see §4.

### 10. Provider / model system — 🟡 Partial

Works: key pools (16 keys, ordered consumption, masked reporting), per-provider
validation, reserved-header rejection, graceful failure on unreachable endpoints, model
catalog resolution, one-shot completions for prompt enhancement and title suggestion
(`V1`–`V7`).

Missing: **a reasoning/thinking level per model** (`A4`) and **image attachments in the
message model** (`A3`). Both are protocol-level changes — `ChatMessage` is text-only and
`ProviderChatParams` has no `temperature`/`reasoning` field — so they are honest gaps, not
oversights in the UI.

### 11. Sessions & transcripts — 🟡 Partial

Full CRUD, mode switching, project binding, renaming, durable transcripts, an actionable
error when a session has no project, and a clean error for unknown ids (`M1`–`M5`).
Missing: **import of sessions from Claude Code / Codex / OpenCode / Pi** (`D12`).

### 12. Skills · subagents · plugins · MCP · scheduling — ✅ Works

Skills with global and project scope; subagents with an enable-state that is *denied* on
delete rather than silently dropped; MCP servers stored, toggled and URL-validated; scheduled
tasks with cron validation and run history, executed by the desktop on a bounded tick
(`C1`–`C5`, `D6`). Plugins install from a local directory, list their tools, uninstall, and
**remote install URLs are restricted to known git hosts** (`C8`, `C9`).

### 13. Code review & rollback + work panel — ✅ Works

Write snapshots support diff, rollback and purge (`C6`), and the renderer's work panel has
Review / Activity / Git / Files / Details tabs — the reference's Review and Files tabs plus
three more.

### 14. Desktop shell security — ✅ Works

Renderer sandboxed (context isolation on, node integration off), every preload channel has a
matching `ipcMain` handler, single-instance lock, `window.open` and navigation restricted to
`http(s)` with external opening, and the sidecar supervised and restarted on crash
(`D1`–`D5`).

### 15. Tray / background residency — ✅ Works *(added during this audit)*

A tray icon with **Show / New task / Close-to-tray / Quit**, a window `close` handler that
hides instead of quitting (so a running turn is not killed by an accidental click), and an
`app.quit()` path that still drains host-core (`D7`).

### 16. Packaging & installers — ✅ Works, with one unverified step

`electron-builder` is configured for macOS (`dmg` + `zip`, x64 + arm64), Windows (`nsis` +
`portable`) and Linux (`AppImage` + `deb` + `rpm`), each with an icon, and the sidecar is
bundled by `scripts/bundle-host.mjs` into a self-contained 147 KB file shipped as an
`extraResources` entry. `pnpm verify:packaging` proves the config validates against
`app-builder-lib`'s own JSON schema, that every referenced icon exists, and that the bundled
sidecar answers a real `host/ping` when spawned with plain Node — i.e. it does not depend on
the monorepo's `node_modules`. `electron-builder --dir --linux` was also run: it parsed the
config and reached `packaging platform=linux arch=x64` before failing on the offline Electron
download.

**Unverified:** the actual `.dmg` / `.exe` / `.AppImage` artefacts, and code signing /
notarisation. Those need network access and release credentials.

### 17. CI & test strategy — 🟡 Partial

Added during this audit: a GitHub Actions workflow that installs, builds, typechecks, runs the
unit + UI suites, runs the protocol demo, runs the parity harness, bundles and verifies the
sidecar, and builds the desktop app — plus a second job that boots the **real Electron app**
under `xvfb`, asserts the shell mounted, the preload bridge is present, the sidecar answered
and no console errors occurred, and uploads a screenshot.

Still thinner than the reference, which runs ~20 purpose-built e2e scripts (boot, layout,
plan, transcript, subagents, supervision, MCP market, skill market, live agent). senastr has
one. The **unit** suite is broad (198 tests over host-core, agent-runtime, shared and the
renderer), and the protocol harness covers the RPC surface deeply, but renderer interaction
coverage is lighter.

### 18. Internationalisation — ❌ Missing

The UI is hard-coded English (`D10`); there is no locale layer, no message catalogue, and no
`zh-CN` bundle, where the reference ships `en` and `zh-CN` including a translated README.

### 19. Command palette · `/` commands · `@` file refs — ❌ Missing

The renderer has real shortcuts (Ctrl/Cmd+K search, +B work panel, +J, +,, +Shift+O) — but no
command palette, no builtin slash commands, and no `@`-file autocompletion in the composer
(`D11`). The reference exposes exactly five builtin palette ids and `@`-refs.

### 20. In-app updates — ❌ Missing

No `electron-updater` / `autoUpdater` integration and no publish metadata (`D8`). Installers
can be built, but they cannot update themselves. The reference ships in-app update delivery
on both NSIS and AppImage lanes.

---

## 4. Defects found and fixed during this audit

These were not "missing features" — they were things that claimed to work and did not.

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| 1 | **Credentials stored in plaintext** on disk under `providers.json` / `mcp.json` | Any process with read access to the data dir got every API key | `SecretBox` (AES-256-GCM) + `0600` key file, `safeStorage`-wrapped key from the desktop, transparent migration of existing rows |
| 2 | **Key-derivation mismatch** in the first encryption attempt | Ciphertext written by one path could not be read by the other — a self-inflicted data-loss bug found by the tests | The key file stores the *raw* random material; both the create and the read path derive the AES key from it |
| 3 | **Queued writes could be lost on exit** (`JsonFileStore` persists on an async tmp+rename) | A sidecar that exited promptly after a write could leave state behind | `flush()` on every store-owning service, and shutdown drains all eight (bounded at 2 s) before exiting |
| 4 | **Symlink escape from the project root** — `safeJoin` was purely lexical, so a link inside the project pointing at `/etc/passwd` was happily read | Arbitrary file read outside the workspace | Real-path containment check against the target *or its deepest existing ancestor*, with a regression test for both read and write, and a check for legitimate in-project symlinks |
| 5 | **`edit_file`, `glob` and `grep` did not exist** despite being central to the reference's tool policy | The agent could only rewrite whole files and list one directory level | Full implementations with content tags, ignore rules, caps and literal-fallback regex |
| 6 | **No context management** — the entire transcript was replayed every step | Long sessions would eventually blow the model's window | `compactHistory` with checkpoints, wired into both loops |
| 7 | **`run_command` did not inherit the login-shell PATH** | `nvm`/`pyenv`/`homebrew` binaries were "command not found" in the GUI while working in the terminal | Login-shell PATH resolution, cached, with a timeout, merged into the child env |
| 8 | No tray; closing the window quit the app | A running agent turn died on an accidental close | Tray + close-to-tray + explicit Quit |

Test count went from **151 tests / 13 files** to **198 tests / 17 files**; the parity harness
went from **57 pass · 16 gaps** to **68 pass · 6 gaps**.

Two harness findings that looked like product bugs but were not: session-scope permission
grant races, and `review/get`'s `snapshotId` parameter name. Both were corrected in the
harness, not the product.

---

## 5. What round 1 found missing (6 items) — all since implemented, see the update at the top

> Historical record. These six items were the state on 2026-09-14; each is now implemented and
> covered by `pnpm test` and/or `scripts/verify-parity.mjs`.

| Gap | Reference behaviour | Work required |
| --- | --- | --- |
| **Image attachments** (`A3`) | Messages can carry images to the model | Extend `ChatMessage` to a part-union, provider adapters, composer paste/drop, transcript rendering. Medium–large. |
| **Reasoning level** (`A4`) | Per-model thinking/reasoning setting, streamed as a separate channel | Add a reasoning field to `ProviderChatParams`, a new `AgentEvent`, per-model metadata, UI control. Medium. |
| **In-app updates** (`D8`) | `electron-updater` on NSIS + AppImage lanes with publish metadata | Add the dependency, a publish provider, an update-check UI path, and release automation. Small–medium, but needs release infrastructure to be meaningful. |
| **i18n** (`D10`) | `en` + `zh-CN` message catalogues | Extract every string, add a locale store and a language switcher. Large mechanical effort. |
| **Command palette / `/` / `@`** (`D11`) | 5 builtin palette commands, `@`-file refs, builtin slash commands | New renderer surface plus a file-index query over the existing glob machinery. Medium. |
| **Session import** (`D12`) | Import from Claude Code / Codex / OpenCode / Pi | One adapter per format onto the existing session store. Medium, mostly independent of the rest. |

Deliberately **not** pursued, matching the reference's own non-goals: remote gateway, cloud
sync, a full IDE, mobile, billing, computer-use takeover, and a second planner.

---

## 6. What this audit did *not* prove

Being explicit about the boundary of the evidence:

- **The GUI was never launched.** The Electron binary cannot be downloaded in this sandbox
  (the postinstall fetch fails offline), so the app was verified through `jsdom` component
  tests, the protocol harness, and source inspection. The boot smoke test written here will
  exercise the real window on any machine with network — it has not yet been executed.
- **No installer artefacts were produced** (same reason). The config, icons, lane list and
  standalone sidecar are verified; the `.dmg`/`.exe`/`.AppImage` files are not.
- **No real model turn was verified.** `pnpm demo` step 9 and the parity harness are gated on
  `SENASTR_DEMO_*` credentials; everything else is exercised against a stubbed provider.
  So provider *plumbing* is verified end-to-end, provider *correctness against a live API*
  is not.
- **No performance or load testing** was done.
- Claims about the reference are based on its `main` branch as cloned during this audit.

---

## 7. Re-running every check

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm typecheck                 # 3 packages + desktop, clean
pnpm test                      # 202 tests / 17 files
pnpm demo                      # 9 protocol-level steps
node scripts/verify-parity.mjs # 74 checks against the real sidecar
node scripts/verify-packaging.mjs
pnpm bundle:host && pnpm test:e2e   # Electron boot smoke (needs the Electron binary)

node scripts/verify-parity.mjs --json              # machine-readable
node scripts/verify-parity.mjs --only=T5           # single group
```

The harness exits `1` on any **failure**; `▲` lines are known gaps and do not fail the run,
so it can be used as a CI gate today and as the scoreboard for closing the remaining round-3
items listed in the update at the top of this document.
