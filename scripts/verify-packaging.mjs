#!/usr/bin/env node
/**
 * Packaging verification that works offline.
 *
 * `electron-builder` needs to download the Electron distribution archive to
 * produce an installer, which is impossible in a sandbox/offline CI. This
 * script checks everything else that can be checked locally, so a broken
 * packaging config fails fast and with a precise reason:
 *
 *   1. apps/desktop/package.json `build` block validates against
 *      app-builder-lib's own JSON schema (the same schema electron-builder
 *      parses).
 *   2. Every per-platform icon file referenced by that config exists.
 *   3. The bundled host-core sidecar exists, is bundled (not a stub), and
 *      answers a real `host/ping` over NDJSON when spawned with plain Node —
 *      i.e. it does not depend on the monorepo node_modules layout.
 *   4. The desktop main bundle references the packaged sidecar path.
 *
 * Usage: node scripts/verify-packaging.mjs
 * Exit:  0 all checks pass, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps", "desktop");
const rel = (p) => p.replace(root + "/", "");

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

console.log("packaging verification");

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const build = pkg.build ?? {};

check("electron-builder config validates against app-builder-lib's schema", () => {
  const require = createRequire(join(desktopDir, "package.json"));
  let schemaPath;
  let Ajv;
  try {
    // Resolve from electron-builder's own context: `app-builder-lib` and `ajv`
    // are its dependencies, not the app's, so a plain resolve would fail under
    // pnpm's strict layout.
    const fromBuilder = createRequire(require.resolve("electron-builder/package.json"));
    schemaPath = fromBuilder.resolve("app-builder-lib/scheme.json");
    Ajv = fromBuilder("ajv");
  } catch {
    return "skipped — electron-builder not installed";
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new (Ajv.default ?? Ajv)({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(build)) {
    throw new Error(
      (validate.errors ?? [])
        .slice(0, 5)
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join("; "),
    );
  }
  return `${Object.keys(build).length} keys`;
});

check("installer lanes cover macOS, Windows and Linux", () => {
  const missing = ["mac", "win", "linux"].filter((p) => !build[p]?.target);
  assert(missing.length === 0, `no target configured for: ${missing.join(", ") || "none"}`);
  const targets = ["mac", "win", "linux"].map(
    (p) => `${p}:${(build[p].target ?? []).map((t) => (typeof t === "string" ? t : t.target)).join("+")}`,
  );
  return targets.join(", ");
});

check("per-platform icon files exist", () => {
  const icons = ["mac", "win", "linux"].map((p) => build[p]?.icon).filter(Boolean);
  assert(icons.length === 3, `expected an icon for each platform, found ${icons.length}`);
  for (const icon of icons) {
    assert(existsSync(join(desktopDir, icon)), `missing icon file: ${icon}`);
    assert(statSync(join(desktopDir, icon)).size > 1024, `icon looks empty: ${icon}`);
  }
  return icons.map((i) => rel(join(desktopDir, i)))[0];
});

const sidecar = join(desktopDir, "resources", "host-core", "main.js");

check("host-core sidecar is bundled into the app resources", () => {
  assert(existsSync(sidecar), "run `pnpm bundle:host` first");
  const bundle = readFileSync(sidecar, "utf8");
  assert(bundle.includes("host/ping"), "bundle does not look like host-core");
  assert(!bundle.includes('require("@senastr/host-core")'), "bundle still depends on workspace packages");
  return `${rel(sidecar)} (${Math.round(statSync(sidecar).size / 1024)} KB)`;
});

check("the sidecar runs standalone (no monorepo node_modules)", () => {
  assert(existsSync(sidecar), "run `pnpm bundle:host` first");
  const dataDir = join(tmpdir(), `senastr-pkg-verify-${Date.now()}`);
  const result = spawnSync(process.execPath, [sidecar, "--data-dir", dataDir], {
    input: '{"jsonrpc":"2.0","id":1,"method":"host/ping"}\n',
    encoding: "utf8",
    timeout: 15_000,
  });
  const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
  const first = lines.length ? JSON.parse(lines[0]) : null;
  assert(first?.result?.ok === true, `sidecar did not answer host/ping (stdout: ${result.stdout || "<empty>"})`);
  return `protocol v${first.result.protocolVersion}, version ${first.result.version}`;
});

check("desktop main bundle resolves the packaged sidecar path", () => {
  const main = join(desktopDir, "out", "main", "index.js");
  assert(existsSync(main), "run `pnpm --filter @senastr/desktop build` first");
  const source = readFileSync(main, "utf8");
  assert(source.includes("senastr-host-core"), "packaged sidecar path is not referenced");
  assert(/resourcesPath/.test(source), "sidecar path does not use process.resourcesPath");
  return rel(main);
});

check("extraResources ships the sidecar next to the asar", () => {
  const entries = build.extraResources ?? [];
  const entry = entries.find((e) => String(e.from).includes("host-core"));
  assert(entry, "extraResources does not include resources/host-core");
  assert(entry.to === "senastr-host-core", `unexpected destination: ${entry.to}`);
  return `${entry.from} → ${entry.to}`;
});

console.log(failures === 0 ? "packaging: OK" : `packaging: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
