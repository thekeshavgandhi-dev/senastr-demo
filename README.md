<div align="center">

# senastr

### The local-first workspace for AI coding agents.

**Bring your own model. Open any local project. Let the agent work — while you stay in control.**

Local-first · Model-agnostic · Permission-gated · Extensible

</div>

---

senastr is a desktop workspace for AI coding agents. You open a local
project, pick any model (OpenAI, Anthropic, Google Gemini, or any compatible
endpoint such as OpenRouter, Ollama or vLLM), and the agent inspects, modifies and runs
things in that project — while every privileged action passes through a
local permission layer that you approve.

**No account. No relay. No lock-in.** Sessions, transcripts, credentials and
configuration stay on your machine. Model requests go directly to the
endpoint you configure.

> senastr is a from-scratch implementation that follows the architecture of
> [PI-Desktop](https://github.com/vastsa/PI-Desktop): Electron shell, a
> sidecar **host core** owning all local state, a separate **agent runtime**
> for the model loop, and a typed JSON-RPC contract between them. See
> [docs/adr](docs/adr) for the decisions and how they map to the reference.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron app (apps/desktop)                                     │
│                                                                 │
│  ┌──────────────────────────────┐   ┌────────────────────────┐  │
│  │ Renderer (React)             │   │ Main process           │  │
│  │  • sidebar, topbar, search   │   │  • window + lifecycle  │  │
│  │  • composer: modes, queue    │   │  • owns agent runtime  │  │
│  │  • transcript, work panel    │◄──┤  • narrow typed IPC    │  │
│  │  • settings, permission UI   │   │    surface             │  │
│  │  • sandboxed; no secrets     │   └───────────┬────────────┘  │
│  └──────────────────────────────┘               │               │
└──────────────────────────────────────────────────┼───────────────┘
                                                  │ in-process
                    ┌─────────────────────────────▼─────────────┐
                    │ Agent runtime (packages/agent-runtime)    │
                    │  • model → tool-call → result loop        │
                    │  • OpenAI/Responses, Anthropic + Gemini   │
                    │  • streaming events, skills, abort        │
                    └─────────────────────────────┬─────────────┘
                                                  │ NDJSON JSON-RPC
                                                  │ over stdio
                    ┌─────────────────────────────▼─────────────┐
                    │ Host core sidecar (packages/host-core)    │
                    │  • sessions + transcripts (local files)   │
                    │  • providers + API keys (never rendered)  │
                    │  • tools: read/write/list/shell           │
                    │  • permission gateway (grants, 120s deny) │
                    │  • plugins, skills + MCP registry/runtime │
                    └───────────────────────────────────────────┘
```

Key properties:

- **One wire contract.** Everything crosses a single NDJSON JSON-RPC channel
  defined in [`packages/shared`](packages/shared). The desktop, the headless
  demo and the tests all speak the same protocol.
- **Storage ownership.** The host core is the only process that touches disk.
  The renderer sees only masked views (no API keys, ever).
- **Desktop experience.** Project-grouped sessions with pin/archive/fork, Build/Plan agent modes, Ask/Accept-edits/Auto permission modes, a prompt queue, @file autocomplete, file attachments, a Review/Files/Details work panel, global search (Ctrl+K), keyboard shortcuts, and light/dark themes.
- **Permission layer.** `read` tools run freely; `write`/`exec` tools need a
  grant or an interactive approval. Unanswered prompts are **denied after
  120s**. Grants are per tool per session (or "always") and revocable.
- **Project confinement.** All tool paths resolve inside the session's
  project directory; anything escaping it is rejected.
- **Extensible.** Settings now includes the capability workbench used by the
  reference app: declarative plugins, global/project Markdown skills, and MCP
  servers over stdio or Streamable HTTP. Plugin and MCP tools get the same
  confinement and permission gating as builtins.
- **Provider catalog + live models.** Pick from named services (OpenAI,
  Anthropic, Gemini, OpenRouter, Groq, xAI, Mistral, DeepSeek, NVIDIA NIM,
  Ollama, LM Studio and more) or configure a custom endpoint. Model IDs are
  discovered from the provider and selected explicitly; custom IDs and
  non-auth routing headers are supported.
- **Key pools + rate-limit failover.** Every provider accepts multiple API
  keys. When a key hits its limit (HTTP 429, `Retry-After` honored) or is
  rejected (401/403), the next key in the pool takes over automatically —
  cooled-down keys rejoin the round-robin — so a rate limit never stops the
  agent mid-task. An optional per-provider "requests per minute" throttle
  keeps you under the provider's limits before they can reject you.

## Quick start

Requirements: Node ≥ 22.12 and pnpm ≥ 10 (`corepack enable`).

```sh
pnpm install        # installs everything incl. the Electron binary
pnpm build          # builds packages + the desktop app
pnpm dev            # starts the desktop app (Electron) with hot reload
```

First run: **Open project…** → pick a folder → **Settings → Models** →
**Add provider** → choose a service, fetch and select its models → chat. The
same Settings workspace manages **Skills**, **MCP**, **Extensions**, and
standing permission grants.

To try a fully local model, add an OpenAI-compatible provider pointing at
Ollama: base URL `http://127.0.0.1:11434/v1`, no API key, model e.g.
`qwen2.5-coder:7b`.

### Headless demo (no GUI)

```sh
pnpm build:packages && pnpm demo
```

Boots the real host-core sidecar and exercises ping, tools, permission
prompts (deny + allow), shell execution and plugin install. With
`SENASTR_DEMO_KIND`, `SENASTR_DEMO_MODEL`, `SENASTR_DEMO_API_KEY` (and
optionally `SENASTR_DEMO_BASE_URL`, `SENASTR_DEMO_PROMPT`) it also runs a
real model turn through the agent runtime.

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | build packages, launch the Electron app in dev mode |
| `pnpm build` | build all packages + the desktop app |
| `pnpm build:packages` | build only the TS packages |
| `pnpm typecheck` | typecheck packages + desktop (node + web) |
| `pnpm test` | run all vitest suites (protocol, host-core, agent loop, renderer UI) |
| `pnpm test:ui` | run only the renderer component tests (jsdom + Testing Library) |
| `pnpm demo` | headless end-to-end exercise of the core |
| `pnpm clean` | remove build outputs |

## Repository layout

```
apps/desktop            Electron app: main, preload, React renderer
packages/shared         wire protocol: JSON-RPC shapes, models, tool catalog
packages/host-core      the sidecar: storage, tools, permissions, plugins
packages/agent-runtime  the agent loop + streaming model providers
examples/plugins        sample plugin (hello-senastr)
scripts/demo.mjs        headless end-to-end demo
docs/adr                architecture decision records
```

## Data & privacy

Host-core keeps all state in one local directory. The standalone sidecar uses
`~/.senastr`; the desktop uses its platform-specific Electron user-data folder
and shows the exact path under **Settings → About**. Set `SENASTR_DATA_DIR` to
override either default.

```text
<host-data>/
├── sessions/<id>.json    transcripts (one file per session)
├── providers.json        provider configs incl. API keys
├── grants.json           standing permission grants
├── skills.json           global/project instruction packs
├── mcp-servers.json      MCP transports and credentials
├── plugins.json          installed plugin registry
└── plugins/<name>/       installed plugin folders
```

senastr has no hosted relay or telemetry path. Network traffic goes only to
model providers and Streamable HTTP MCP endpoints you configure (including
connection/model-discovery probes), plus anything you explicitly approve a
local command or extension to run.

## Parity with PI-Desktop

senastr is a from-scratch implementation of the architecture of
[PI-Desktop](https://github.com/vastsa/pi-desktop). `docs/pi-desktop-parity.md`
records a feature-by-feature audit against it, with the evidence for each
claim; `scripts/verify-parity.mjs` reproduces the checks against a live
host-core (currently 68 passing, 0 failing, 6 known gaps).

Shipped: the agent loop and its supervision, the ten builtin tools including
tag-verified line-anchored edits, glob and grep, the permission layer, project
confinement (lexical *and* through symlinks), AES-256-GCM credential encryption
behind a keychain-wrapped key, context compaction with checkpoints, durable
sidecar state, plan mode with server-side denial, subagents, skills, plugins,
MCP, scheduled tasks, review/rollback, the work panel, a sandboxed renderer, a
tray, electron-builder packaging with a bundled sidecar, and CI.

## Roadmap

- **Image attachments** and a **reasoning level** — protocol-level changes to
  the message model and provider params
- **Command palette, `/` commands and `@` file references** in the composer
- **Session import** from Claude Code / Codex / OpenCode / PI-Desktop
- **i18n** (message catalogues + a language switcher)
- **In-app updates** (electron-updater on the NSIS and AppImage lanes)
- **Host core in Rust**: the protocol is already process-isolated; swapping
  the TS implementation for a Rust binary (à la PI-Desktop ADR 0010) is an
  upgrade path that doesn't touch the wire contract
- **SQLite storage** behind the same store interface
- Session forking
- **Dynamic plugins** (code-loaded, sandboxed) behind the same manifest
- MCP OAuth and richer transport diagnostics; the stdio and Streamable HTTP
  runtime, connection tests, secret masking, and tool routing are available now
