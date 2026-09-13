# ADR 0003: Host core as a sidecar over NDJSON JSON-RPC (TypeScript first, Rust later)

- Status: Accepted
- Date: 2026-09-13

## Context

senastr needs a robust local backend: filesystem tools, command execution,
credential storage, the permission gateway, plugin registry. PI-Desktop
freezes this as a **Rust sidecar** (ADR 0010) speaking **stdio NDJSON
JSON-RPC** (ADR 0011), with the agent engine on the Node side.

## Decision

Keep the exact process model and transport, but implement the host core in
**TypeScript/Node for v0**:

- Transport: **NDJSON JSON-RPC 2.0 over stdio** (one JSON object per line;
  numeric request ids; server→client events as notifications).
- The sidecar is spawned by the Electron main with `ELECTRON_RUN_AS_NODE=1`,
  so dev and packaged apps need no separate Node install.
- A Rust implementation is a later upgrade path that does not touch the wire
  contract.

### Responsibility split

| Layer | Tech | Owns |
| --- | --- | --- |
| UI | React + TypeScript | rendering, UX state |
| Electron shell | TypeScript | windows, preload bridge, lifecycle |
| Host core | **TypeScript (v0) → Rust (later)** | storage, tools, permission gateway, plugins, credentials |
| Agent engine | TypeScript | model providers, agent loop, tool orchestration |

## Rationale

1. The **protocol is the real architectural asset**; the sidecar's language
   is an implementation detail behind it. Everything in `packages/shared`
   (methods, error codes, models) is transport- and language-agnostic.
2. A Rust toolchain is not available in the current development environment;
   a TypeScript sidecar keeps v0 shippable today with the same isolation
   properties (separate process, protocol-only wire, no shared memory).
3. Same-language debugging across the whole stack while the product shape is
   still moving.

## Consequences

- + Sidecar isolation from day one; UI and agent can never touch disk or
  secrets directly.
- + Swapping in a Rust binary later only requires re-implementing methods.
- − Slightly weaker hard isolation than a compiled binary for v0 (mitigated
  by the confined tool implementations and the fact the sidecar only ever
  executes user-approved commands).

## Related

- `packages/shared/src/protocol.ts` — the frozen contract
- PI-Desktop ADR 0010 / 0011 — the reference decisions this mirrors
