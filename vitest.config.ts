import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Two test projects:
 *  - packages: the existing Node-side unit tests (host core, agent runtime, shared).
 *  - desktop-ui: jsdom component tests for the React renderer, using the same
 *    source aliases the electron-vite renderer build uses (browser-safe shared
 *    entry, provider-presets source, `@` → renderer root).
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: "packages",
          include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./apps/desktop/src/renderer", import.meta.url)),
            "@senastr/shared": fileURLToPath(new URL("./packages/shared/src/browser.ts", import.meta.url)),
            "@senastr/provider-presets": fileURLToPath(
              new URL("./packages/shared/src/provider-presets.ts", import.meta.url),
            ),
          },
        },
        esbuild: { jsx: "automatic" },
        test: {
          name: "desktop-ui",
          include: ["apps/desktop/src/renderer/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["apps/desktop/src/renderer/test/setup.ts"],
        },
      },
    ],
  },
});
