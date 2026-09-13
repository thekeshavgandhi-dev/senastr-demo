import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { join } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@": join(__dirname, "src/renderer"),
        // The renderer needs this one value catalog. Point at its browser-safe
        // source module rather than pulling the shared CommonJS barrel (which
        // also exports the Node-only sidecar RPC client) into the web bundle.
        "@senastr/provider-presets": join(
          __dirname,
          "../../packages/shared/src/provider-presets.ts",
        ),
      },
    },
  },
});
