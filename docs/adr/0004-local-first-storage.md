# ADR 0004: Local-first storage — host-core owns all state, JSON files for v0

- Status: Accepted
- Date: 2026-09-13

## Context

Sessions, transcripts, provider credentials, permission grants and installed
plugins must persist locally. PI-Desktop freezes **exclusive storage
ownership by the host core** (Rust/SQLite) — the UI never writes state.

## Decision

1. The host core is the **only** process that reads or writes local state.
2. v0 persists state as **JSON documents** under the data dir with atomic
   writes (tmp file + rename), behind a single `JsonFileStore` abstraction:

   ```
   ~/.senastr/            (override: SENASTR_DATA_DIR)
   ├── sessions/<id>.json
   ├── providers.json
   ├── grants.json
   ├── plugins.json
   └── plugins/<name>/
   ```

3. Credentials (API keys) are stored by the host core and **never sent to the
   renderer**; the renderer sees `hasApiKey` flags. The only key-bearing RPC
   (`provider/get`) is called by the Electron main, which resolves it per
   turn.

## Rationale

- One writer removes sync bugs between UI state and disk.
- Plain JSON is human-inspectable, trivially testable, and adequate at v0
  transcript sizes; the `JsonFileStore` boundary means SQLite (or the Rust
  sidecar's DB) can replace it without touching callers.

## Consequences

- + Full local-first privacy story; no telemetry, no account.
- + Tests can point the data dir at a temp folder.
- − No transactions/indexes yet; acceptable until transcripts get large.
