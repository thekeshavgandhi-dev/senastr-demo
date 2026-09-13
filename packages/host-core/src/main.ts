#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, SENASTR_VERSION } from "@senastr/shared";
import { RpcServer } from "./server";
import { SessionStore } from "./sessions";
import { ProviderStore } from "./providers";
import { PermissionService } from "./permissions";
import { ToolRunner } from "./tools/runner";
import { PluginService } from "./plugins";
import { SkillService } from "./skills";
import { McpService } from "./mcp";
import { registerMethods } from "./methods";

/**
 * senastr host-core — the local sidecar process.
 *
 * Stdin/stdout are the NDJSON JSON-RPC wire (protocol only). Diagnostics go
 * to stderr. The process owns all local state (ADR 0004): sessions,
 * providers + credentials, permission grants, installed plugins.
 */
function parseArgs(argv: string[]): { dataDir?: string } {
  const parsed: { dataDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--data-dir":
        parsed.dataDir = argv[++i];
        break;
      case "--version":
        process.stdout.write(`${SENASTR_VERSION}\n`);
        process.exit(0);
        break;
      case "--help":
        process.stderr.write(
          "usage: senastr-host-core [--data-dir <path>]\n" +
            "  --data-dir  directory for all local state (default: $SENASTR_DATA_DIR or ~/.senastr)\n",
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown argument: ${argv[i]}\n`);
        process.exit(2);
    }
  }
  return parsed;
}

function main(): void {
  const { dataDir: flag } = parseArgs(process.argv.slice(2));
  const dataDir = resolve(flag ?? process.env.SENASTR_DATA_DIR ?? join(homedir(), ".senastr"));
  mkdirSync(dataDir, { recursive: true });

  const server = new RpcServer({ stdin: process.stdin, stdout: process.stdout });
  const sessions = new SessionStore(join(dataDir, "sessions"));
  const providers = new ProviderStore(dataDir);
  const permissions = new PermissionService(dataDir, (method, params) => server.notify(method, params));
  const plugins = new PluginService(dataDir);
  const skills = new SkillService(dataDir);
  const mcp = new McpService(dataDir);
  const tools = new ToolRunner(sessions, permissions, plugins, mcp);

  registerMethods({ server, dataDir, sessions, providers, permissions, tools, plugins, skills, mcp });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[senastr/host-core] ${signal} — shutting down\n`);
    mcp.dispose();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.start();
  process.stderr.write(
    `[senastr/host-core] ${SENASTR_VERSION} ready (protocol v${PROTOCOL_VERSION}, data: ${dataDir})\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`[senastr/host-core] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}
