# ADR 0007: UI stack — React 19 + Vite via electron-vite, no component framework

- Status: Accepted
- Date: 2026-09-13

## Context

The renderer needs a chat workspace: session sidebar, message transcript with
tool blocks, composer with model switching, permission dialog, settings.
Options: React/Vue/Svelte, with or without a component library.

## Decision

- **React 19** with a single custom `useSenastr` state hook (no Redux/Zustand
  for v0), built by **Vite** through **electron-vite** (one build config for
  main/preload/renderer).
- Hand-written CSS with design tokens (dark theme). No component library —
  the surface is small and a library would dominate the bundle.
- Renderer is fully sandboxed: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`; the only bridge is the typed `window.senastr`
  preload API.

## Rationale

1. React gives the largest talent pool and the richest ecosystem if the UI
   grows (markdown rendering, diff views) later.
2. electron-vite keeps dev (HMR) and prod (CJS bundles) on one config and
   matches the reference product's toolchain family.
3. A custom hook keeps state explicit and auditable at v0 scale; the event
   stream from the agent is the only "real-time" concern and maps directly to
   reducer-style updates.

## Consequences

- + Fast iteration; small bundle (~700KB renderer incl. React).
- + Security posture: no renderer access to node, files or secrets.
- − We own the CSS; acceptable for a single-view workspace.

## Roadmap notes

- Markdown/code rendering in transcripts (currently plain text).
- CSP meta header once the HMR-free prod build is the only target.
