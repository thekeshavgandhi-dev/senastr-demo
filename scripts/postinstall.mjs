#!/usr/bin/env node
/**
 * pnpm postinstall — ensures the Electron binary is present.
 *
 * Context:
 * - Electron 42+ removed its `postinstall: node install.js` hook and now
 *   does a lazy download on `require('electron')`. `electron-vite` checks
 *   for `path.txt` / `dist` synchronously and throws `Electron uninstall`
 *   if they are missing, so the lazy path never runs.
 * - pnpm 10 blocks lifecycle scripts by default (`onlyBuiltDependencies`).
 *   `esbuild` and `electron-winstaller` need their `postinstall` to run
 *   (handled in `pnpm-workspace.yaml`). Electron itself no longer has a
 *   postinstall, so we trigger the download explicitly here.
 *
 * This script is best-effort: it succeeds silently if Electron is not
 * installed (e.g. CI that only builds packages) or if the download fails
 * due to offline/network — the next `require('electron')` will retry lazily.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function findElectronEntry() {
  // pnpm links `apps/desktop/node_modules/electron` -> store.
  const candidates = [
    join(root, "apps", "desktop", "node_modules", "electron", "package.json"),
    join(root, "node_modules", "electron", "package.json"),
    join(root, "node_modules", ".pnpm", "electron@44.3.0", "node_modules", "electron", "package.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: resolve via Node's resolution from desktop
  try {
    const desktopPkg = join(root, "apps", "desktop", "package.json");
    const desktopDir = dirname(desktopPkg);
    const req = createRequire(desktopPkg);
    return req.resolve("electron/package.json");
  } catch {
    return null;
  }
}

function isElectronInstalled(electronPkgPath) {
  const dir = dirname(electronPkgPath);
  const pathTxt = join(dir, "path.txt");
  const distSig = join(dir, "dist", "version");
  if (!existsSync(pathTxt) || !existsSync(distSig)) return false;
  try {
    const v = readFileSync(join(dir, "package.json"), "utf8");
    const { version } = JSON.parse(v);
    const recorded = readFileSync(distSig, "utf8").replace(/^v/, "").trim();
    if (recorded !== version) return false;
    const exe = readFileSync(pathTxt, "utf8").trim();
    const full = join(dir, "dist", exe);
    return existsSync(full);
  } catch {
    return false;
  }
}

function runInstall(electronDir) {
  const installJs = join(electronDir, "install.js");
  if (!existsSync(installJs)) {
    console.warn(`[postinstall] electron install.js not found at ${installJs}`);
    return false;
  }
  console.log("[postinstall] Electron binary missing — downloading via install.js ...");
  const result = spawnSync(process.execPath, [installJs], {
    stdio: "inherit",
    cwd: electronDir,
    env: process.env,
  });
  if (result.status !== 0) {
    console.warn(
      `[postinstall] Electron download failed (exit ${result.status}). ` +
        `This is common offline or behind a proxy. ` +
        `Run manually once online:  pnpm --filter @senastr/desktop exec node ./node_modules/electron/install.js`
    );
    return false;
  }
  return true;
}

const pkgPath = findElectronEntry();
if (!pkgPath) {
  console.log("[postinstall] electron not installed — skipping Electron download (maybe filtered install).");
  process.exit(0);
}

if (isElectronInstalled(pkgPath)) {
  console.log("[postinstall] Electron already installed — skipping.");
  process.exit(0);
}

const dir = dirname(pkgPath);
const ok = runInstall(dir);
if (ok && isElectronInstalled(pkgPath)) {
  console.log("[postinstall] Electron installed successfully.");
  process.exit(0);
}

// Best-effort: don't fail the whole `pnpm install` if download failed.
// The next `require('electron')` or manual `node install.js` will retry.
process.exit(0);
