# ADR 0005: Permission layer — risk levels, toolName grants, 120s deny

- Status: Accepted
- Date: 2026-09-13

## Context

The agent can read files, write files and run commands. PI-Desktop freezes
the same defaults we adopt: **permission timeout = 120s deny**, **grants by
toolName**, and privileged tools always pass through the host's permission
gateway.

## Decision

Tools carry a risk level in the shared catalog:

| Risk | Tools | Behavior |
| --- | --- | --- |
| `read` | `read_file`, `list_dir` | execute without approval |
| `write` | `write_file` | grant or interactive approval |
| `exec` | `run_command`, all plugin tools | grant or interactive approval |

Flow:

1. Agent runtime calls `tool/run` through the host bridge.
2. Host checks grants (`grants.json`): per `(tool, session)` or `always`.
3. No grant → host creates a pending request, **notifies** the UI
   (`permission/requested`) and **blocks** the call.
4. UI answers `permission/respond` { allow, remember?: "session" }.
5. No answer within **120s → denied** (the tool call returns an error the
   model can see and react to).

Grants are revocable from Settings. Denials are returned as *tool errors*,
not protocol errors, so the model loop stays intact.

## Rationale

- Approvals belong in the host (which owns the side effects), not in the UI.
- Blocking the RPC with a notification out keeps the protocol request/response
  shaped and trivially testable without a UI.
- 120s deny matches the reference and prevents silent agent stalls.

## Consequences

- + User sees exactly what runs (tool, summary, raw args) before it runs.
- + "Allow in this session" removes prompt fatigue within a task.
- − A background user with an unanswered prompt gets a denial after 2 min —
  by design.
