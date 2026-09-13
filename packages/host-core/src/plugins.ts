import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  builtinToolNames,
  ErrorCodes,
  RpcError,
  type PluginInfo,
  type PluginManifest,
  type PluginToolDef,
} from "@senastr/shared";
import { JsonFileStore } from "./store";

export const MANIFEST_FILE = "senastr.plugin.json";

interface InstalledPlugin {
  version: string;
  installedAt: number;
  path: string;
}

/**
 * User-installable plugin registry (ADR 0006).
 *
 * v0 plugins are *declarative*: a manifest with optional shell-command tool
 * templates. No arbitrary code runs in-process; each plugin tool executes
 * through the same confined, permission-gated shell as builtin tools.
 */
export class PluginService {
  private installed: JsonFileStore<Record<string, InstalledPlugin>>;

  constructor(private readonly dataDir: string) {
    this.installed = new JsonFileStore<Record<string, InstalledPlugin>>(
      join(dataDir, "plugins.json"),
      {},
    );
  }

  private pluginsDir(): string {
    return join(this.dataDir, "plugins");
  }

  list(): PluginInfo[] {
    return Object.entries(this.installed.get()).map(([name, meta]) => {
      const manifest = this.readManifestAt(meta.path);
      return {
        name,
        version: manifest?.version ?? meta.version,
        description: manifest?.description,
        tools: (manifest?.tools ?? []).map((t) => t.name),
        installedAt: meta.installedAt,
      };
    });
  }

  readManifest(pluginName: string): PluginManifest | null {
    const meta = this.installed.get()[pluginName];
    return meta ? this.readManifestAt(meta.path) : null;
  }

  findTool(toolName: string): { def: PluginToolDef; plugin: string } | null {
    for (const info of this.list()) {
      const manifest = this.readManifest(info.name);
      const def = manifest?.tools?.find((t) => t.name === toolName);
      if (def) return { def, plugin: info.name };
    }
    return null;
  }

  installFromDir(sourceDir: string): PluginInfo {
    const src = resolve(sourceDir);
    if (!existsSync(src) || !lstatSync(src).isDirectory()) {
      throw new RpcError(ErrorCodes.PLUGIN_INVALID, `plugin directory not found: ${src}`);
    }
    const manifest = this.readManifestAt(src);
    if (!manifest) {
      throw new RpcError(ErrorCodes.PLUGIN_INVALID, `missing ${MANIFEST_FILE} in ${src}`);
    }
    validateManifest(manifest);

    const dest = join(this.pluginsDir(), manifest.name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(this.pluginsDir(), { recursive: true });
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => (p.split(/[\\/]/).pop() ?? "") !== ".DS_Store",
    });

    const installedAt = Date.now();
    this.installed.update((all) => ({
      ...all,
      [manifest.name]: { version: manifest.version, installedAt, path: dest },
    }));
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      tools: (manifest.tools ?? []).map((t) => t.name),
      installedAt,
    };
  }

  uninstall(name: string): void {
    const meta = this.installed.get()[name];
    if (!meta) throw new RpcError(ErrorCodes.PLUGIN_INVALID, `plugin not installed: ${name}`);
    rmSync(meta.path, { recursive: true, force: true });
    this.installed.update((all) => {
      const next = { ...all };
      delete next[name];
      return next;
    });
  }

  private readManifestAt(dir: string): PluginManifest | null {
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as PluginManifest;
    } catch {
      return null;
    }
  }
}

export function validateManifest(m: PluginManifest): void {
  const invalid = (msg: string): never => {
    throw new RpcError(ErrorCodes.PLUGIN_INVALID, msg);
  };
  if (typeof m.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(m.name)) {
    invalid("manifest.name must be a kebab-case slug");
  }
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) {
    invalid("manifest.version must look like semver (x.y.z)");
  }
  const reserved = builtinToolNames();
  for (const tool of m.tools ?? []) {
    if (typeof tool.name !== "string" || !/^[a-z0-9_]+$/.test(tool.name)) {
      invalid(`tool name must be lowercase [a-z0-9_]: ${String(tool.name)}`);
    }
    if (reserved.has(tool.name)) {
      invalid(`tool name collides with a builtin tool: ${tool.name}`);
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      invalid(`tool ${tool.name} needs a description`);
    }
    if (typeof tool.command !== "string" || !tool.command.trim()) {
      invalid(`tool ${tool.name} needs a command`);
    }
  }
}
