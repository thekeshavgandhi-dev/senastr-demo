# Documentation

- [README](../README.md) — product overview, architecture, quick start
- [ADR 0001 — Electron shell](adr/0001-electron-shell.md)
- [ADR 0002 — In-house agent loop](adr/0002-agent-loop.md)
- [ADR 0003 — Host core sidecar over NDJSON JSON-RPC](adr/0003-host-core-sidecar.md)
- [ADR 0004 — Local-first storage](adr/0004-local-first-storage.md)
- [ADR 0005 — Permission layer](adr/0005-permission-layer.md)
- [ADR 0006 — Declarative plugins](adr/0006-declarative-plugins.md)
- [ADR 0007 — UI stack](adr/0007-ui-stack.md)

## Protocol reference (living doc)

The authoritative protocol reference is code:

- Method names + error codes: `packages/shared/src/protocol.ts`
- Wire shapes (sessions, providers, permissions, plugins, events):
  `packages/shared/src/models.ts`
- Builtin tool catalog: `packages/shared/src/tools.ts`
- Host method implementations: `packages/host-core/src/methods.ts`
- Agent events: `AgentEvent` in `packages/shared/src/models.ts`

When changing the protocol: bump considerations —
1. add the method/shape to `packages/shared`
2. implement/adjust host-core + agent-runtime
3. extend the vitest suites (they run the real server over PassThrough streams)
4. note the change in the relevant ADR if it's a behavior change
