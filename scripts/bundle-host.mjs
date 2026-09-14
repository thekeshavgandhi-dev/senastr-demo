#!/usr/bin/env node
/**
 * Bundle host-core into a single self-contained file for the packaged app.
 *
 * electron-builder ships `resources/senastr-host-core/main.js`, which the
 * desktop main process spawns with the bundled Electron runtime. A bundle
 * (instead of the raw tsc output) means the sidecar does not depend on the
 * monorepo's node_modules layout being present inside the packaged app.
 *
 * Usage: node scripts/bundle-host.mjs
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages", "host-core", "src", "main.ts");
const outfile = join(root, "apps", "desktop", "resources", "host-core", "main.js");

if (!existsSync(entry)) {
  console.error(`host-core entry not found: ${entry}`);
  process.exit(1);
}

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  // The packaged sidecar runs under Electron's bundled Node, so keep Node
  // built-ins external and inline everything else (including @senastr/shared).
  external: ["node:*"],
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: "/* senastr host-core — bundled sidecar (see scripts/bundle-host.mjs) */",
  },
});

const size = statSync(outfile).size;
console.log(`bundled host-core → ${outfile.replace(root + "/", "")} (${(size / 1024).toFixed(0)} KB)`);
