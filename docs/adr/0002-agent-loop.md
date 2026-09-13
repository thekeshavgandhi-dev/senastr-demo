# ADR 0002: Build a minimal in-house agent loop (no external agent framework)

- Status: Accepted
- Date: 2026-09-13

## Context

The agent needs an extensible multi-model loop: streaming tokens, tool
calling, abort, and a clean event model for the UI. PI-Desktop uses the pi
Agent Harness (`@earendil-works/pi-ai`) as its kernel. For senastr v0 we
either adopt a framework or build the loop ourselves.

## Decision

Build a **minimal, provider-agnostic agent loop** in
`packages/agent-runtime` with two streaming providers (OpenAI-compatible,
Anthropic), both implemented over bare HTTP/SSE — no SDKs.

## Rationale

1. The loop for v0 is small: one system prompt, a transcript, a tool
   registry, a step cap, abort. A framework would pull in far more concepts
   (extensions, telemetry, catalog authority) than the product needs yet.
2. Bare HTTP/SSE providers keep the dependency tree tiny and make any
   OpenAI-compatible endpoint (Ollama, vLLM, gateways) work by changing a
   base URL.
3. The loop is deliberately isolated behind a `HostBridge` interface, so a
   richer kernel can replace it later without touching the UI or the
   protocol.

## Consequences

- We own tool-call accumulation, SSE parsing and provider edge cases.
- Max-steps safety valve (24) and per-turn abort are built in.
- No vendor lock-in: adding a provider is a new `Provider` implementation.

## Alternatives

- Adopt the pi harness: powerful, but couples senastr to upstream release
  cadence and version constraints (Node ≥ 22.19) from day one; revisit if
  the loop outgrows the v0 shape.
