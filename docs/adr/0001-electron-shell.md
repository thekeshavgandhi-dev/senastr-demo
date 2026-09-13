# ADR 0001: Use Electron as the desktop shell

- Status: Accepted
- Date: 2026-09-13

## Context

senastr needs desktop distribution, a local permission UX, session state, and
system integration. The candidates are Electron and Tauri.

## Decision

Adopt **Electron** as the desktop shell.

## Rationale

1. The agent runtime and host tooling are Node/TypeScript; Electron keeps one
   language across the shell and the agent layer.
2. The reference implementation (PI-Desktop) validated this path for exactly
   this product shape (local-first coding agent workspace).
3. Mature native module, debugging and packaging tooling (electron-builder).

## Consequences

- Faster development; the agent runtime can run in the main process initially.
- Heavier bundle and memory footprint than Tauri — accepted for v0.
- Strict security baseline is mandatory: sandboxed renderer, context
  isolation, no node integration, narrow IPC surface.

## Alternatives

- Tauri 2: lighter, but a Rust frontend-bridge plus a Rust backend doubles
  the surface for a project that is otherwise all TypeScript. Dropped for v0.
