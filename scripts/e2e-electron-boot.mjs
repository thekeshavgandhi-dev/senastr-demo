#!/usr/bin/env node
/**
 * Electron end-to-end smoke test: boots the real desktop app (real preload,
 * real renderer bundle, real host-core sidecar) and asserts that it comes up
 * healthy, then keeps a screenshot of the window as evidence.
 *
 * Requires the Electron binary (`pnpm --filter @senastr/desktop exec node
 * ./node_modules/electron/install.js`). If it is missing — e.g. an offline
 * sandbox — the script exits 0 with a clear SKIP so CI on a machine with
 * network can run it for real.
 *
 * Usage: node scripts/e2e-electron-boot.mjs [--report <file.json>]
 * Env:   SENASTR_E2E_SETTLE_MS  extra settle time before probing (default 2500)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const reportArgIndex = process.argv.indexOf("--report");
const report =
  reportArgIndex >= 0 && process.argv[reportArgIndex + 1]
    ? resolve(process.argv[reportArgIndex + 1])
    : join(tmpdir(), `senastr-e2e-${Date.now()}.json`);

function fail(message) {
  console.error(`e2e-electron-boot: ${message}`);
  process.exit(1);
}

/** Path to the real Electron binary, or null when the postinstall download did not run. */
function electronBinary() {
  let pkgDir;
  try {
    pkgDir = dirname(require.resolve("electron/package.json", { paths: [join(root, "apps", "desktop")] }));
  } catch {
    return null;
  }
  try {
    const rel = readFileSync(join(pkgDir, "path.txt"), "utf8").trim();
    const candidate = join(pkgDir, "dist", rel);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const mainEntry = join(root, "apps", "desktop", "out", "main", "index.js");
if (!existsSync(mainEntry)) {
  fail(`desktop build missing (${mainEntry.replace(root + "/", "")}). Run: pnpm --filter @senastr/desktop build`);
}
if (!existsSync(join(root, "apps", "desktop", "resources", "host-core", "main.js"))) {
  fail("bundled host-core missing. Run: pnpm bundle:host");
}

const binary = electronBinary();
if (!binary) {
  console.log("e2e-electron-boot: SKIP — Electron binary not installed (run the electron install.js step once online).");
  process.exit(0);
}

mkdirSync(dirname(report), { recursive: true });
rmSync(report, { force: true });

const dataDir = join(tmpdir(), `senastr-e2e-data-${Date.now()}`);
const child = spawn(
  binary,
  [
    mainEntry,
    // Containers have no usable SUID sandbox; the app itself keeps
    // contextIsolation + sandbox:true for the renderer, which is what matters.
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${join(dataDir, "userdata")}`,
  ],
  {
    cwd: join(root, "apps", "desktop"),
    env: {
      ...process.env,
      SENASTR_E2E: "1",
      SENASTR_E2E_REPORT: report,
      SENASTR_HOST_CORE: join(root, "apps", "desktop", "resources", "host-core", "main.js"),
      SENASTR_DATA_DIR: dataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});

const timeout = setTimeout(() => {
  console.error("e2e-electron-boot: FAIL — the app did not exit within 90s");
  child.kill("SIGKILL");
  process.exit(1);
}, 90_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    /* no report — handled below */
  }
  if (parsed) {
    console.log(`e2e-electron-boot: report ${report}`);
    if (parsed.screenshot) console.log(`e2e-electron-boot: screenshot ${parsed.screenshot}`);
  }
  if (code === 0 && parsed?.ok) {
    console.log("e2e-electron-boot: PASS");
    process.exit(0);
  }
  console.error(`e2e-electron-boot: FAIL (exit ${code})`);
  if (!parsed) console.error(output.split("\n").slice(-25).join("\n"));
  process.exit(1);
});
