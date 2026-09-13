<div align="center">

# senastr

### The local-first workspace for AI coding agents.

**Bring your own model. Open any local project. Let the agent work — while you stay in control.**

Local-first · Model-agnostic · Permission-gated · Extensible

</div>

---

senastr is a desktop workspace for AI coding agents. You open a local
project, pick any model (OpenAI, Anthropic, or any OpenAI-compatible
endpoint such as Ollama or vLLM), and the agent inspects, modifies and runs
things in that project — while every privileged action passes through a
local permission layer that you approve.

**No account. No relay. No lock-in.** Sessions, transcripts, credentials and
files stay on your machine (`~/.senastr`). Model requests go directly to the
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
│  │  • chat UI, composer         │   │  • window + lifecycle  │  │
│  │  • permission dialog         │   │  • owns agent runtime  │  │
│  │  • provider/plugin settings  │◄──┤  • narrow typed IPC    │  │
│  │  (sandboxed, no node, no     │   │    surface             │  │
│  │   secrets)                   │   └───────────┬────────────┘  │
│  └──────────────────────────────┘               │               │
└──────────────────────────────────────────────────┼───────────────┘
                                                  │ in-process
                    ┌─────────────────────────────▼─────────────┐
                    │ Agent runtime (packages/agent-runtime)    │
                    │  • model → tool-call → result loop        │
                    │  • OpenAI-compatible + Anthropic providers│
                    │  • streaming events, abort, max-steps     │
                    └─────────────────────────────┬─────────────┘
                                                  │ NDJSON JSON-RPC
                                                  │ over stdio
                    ┌─────────────────────────────▼─────────────┐
                    │ Host core sidecar (packages/host-core)    │
                    │  • sessions + transcripts (local files)   │
                    │  • providers + API keys (never leave)     │
                    │  • tools: read/write/list/shell           │
                    │  • permission gateway (grants, 120s deny) │
                    │  • plugin registry                        │
                    └───────────────────────────────────────────┘
```

Key properties:

- **One wire contract.** Everything crosses a single NDJSON JSON-RPC channel
  defined in [`packages/shared`](packages/shared). The desktop, the headless
  demo and the tests all speak the same protocol.
- **Storage ownership.** The host core is the only process that touches disk.
  The renderer sees only masked views (no API keys, ever).
- **Permission layer.** `read` tools run freely; `write`/`exec` tools need a
  grant or an interactive approval. Unanswered prompts are **denied after
  120s**. Grants are per tool per session (or "always") and revocable.
- **Project confinement.** All tool paths resolve inside the session's
  project directory; anything escaping it is rejected.
- **Extensible.** Plugins are declarative manifest + shell-command tools
  (v0), installed/removed from Settings; they get the same confinement and
  permission gating as builtins.

## Quick start

Requirements: Node ≥ 22.12 and pnpm ≥ 10 (`corepack enable`).

```sh
pnpm install        # installs everything incl. the Electron binary
pnpm build          # builds packages + the desktop app
pnpm dev            # starts the desktop app (Electron) with hot reload
```

First run: **Open project…** → pick a folder → **Settings** → add a model
provider (label, base URL, API key, model ids) → chat.

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
| `pnpm test` | run the vitest suites (protocol, host-core, agent loop) |
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

All state lives under `~/.senastr` (override with `SENASTR_DATA_DIR`):

```
~/.senastr/
├── sessions/<id>.json    transcripts (one file per session)
├── providers.json        provider configs incl. API keys
├── grants.json           standing permission grants
├── plugins.json          installed plugin registry
└── plugins/<name>/       installed plugin folders
```

Nothing is uploaded anywhere. The only network traffic is your model requests
to the endpoints you configure, and the provider "test connection" probe.

## Roadmap

- **Packaging**: electron-builder release pipeline + bundled host-core for
  the packaged app layout
- **Host core in Rust**: the protocol is already process-isolated; swapping
  the TS implementation for a Rust binary (à la PI-Desktop ADR 0010) is an
  upgrade path that doesn't touch the wire contract
- **SQLite storage** behind the same store interface
- **Plan mode** (research → frozen plan → approval → execution) and
  session forking
- **Dynamic plugins** (code-loaded, sandboxed) behind the same manifest
- MCP servers, subagents, work panel (diffs/reviews), i18n
