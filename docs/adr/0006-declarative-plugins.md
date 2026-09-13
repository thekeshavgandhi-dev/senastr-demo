# ADR 0006: Plugins — declarative manifest with shell-command tools (v0)

- Status: Accepted
- Date: 2026-09-13

## Context

PI-Desktop ships user-installable plugins with a manifest, a devkit and
progressively stronger runtime isolation. For senastr v0 we need the product
concept (extend the agent with third-party tools) without yet needing a full
code sandbox.

## Decision

v0 plugins are **declarative**:

- A folder containing `senastr.plugin.json`:

  ```json
  {
    "name": "my-plugin",
    "version": "0.1.0",
    "description": "…",
    "permissions": { "fs": ["read"], "net": [] },
    "tools": [
      {
        "name": "my_tool",
        "description": "shown to the model",
        "command": "my-cli {flag} {value}",
        "args": { "type": "object", "properties": { "value": { "type": "string" } } }
      }
    ]
  }
  ```

- Installed via `plugin/install { dir }` (copied into the data dir), listed,
  and uninstalled through the same RPC surface.
- `{arg}` placeholders are substituted **shell-quoted**; templates must not
  add their own quotes around placeholders.
- Plugin tools are risk `exec`: same confinement (project root) and
  permission gating as `run_command`.
- Manifest validation rejects collisions with builtin tool names and malformed
  tools. No JS is loaded by the host.

## Rationale

- Gives the full plugin *product experience* (install/manage/list, tools in
  the catalog) with zero in-process code execution — the strongest isolation
  we can have for v0.
- Validation + confinement + permission gating already cover the failure
  modes that matter (name squatting, path escape, destructive commands).

## Consequences

- + Safe, small, testable plugin format; the example plugin demonstrates it.
- − Plugins can't add UI panels or in-process logic yet.
- Roadmap: dynamic plugins behind the same manifest, with the isolation
  target from PI-Desktop ADR 0008 as the north star.
