/**
 * Browser-safe entry for @senastr/shared.
 *
 * The renderer must never bundle the CommonJS barrel (dist/index.js), which
 * re-exports the Node-only sidecar RPC client. This module exposes the pure
 * protocol surface (constants + tool catalog + provider presets); the
 * desktop's electron-vite config aliases "@senastr/shared" here for the web
 * build, while main/preload keep using the full barrel.
 */
export * from "./protocol";
export * from "./models";
export * from "./tools";
export * from "./provider-presets";
export * from "./thinking-levels";
export * from "./network-proxy";
export * from "./commands";
export * from "./composer-trigger";
