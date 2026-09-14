import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  /** Missing on v0 registries; those installations remain enabled. */
  enabled?: boolean;
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

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.installed.flush();
  }

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
        author: manifest?.author,
        tools: (manifest?.tools ?? []).map((t) => t.name),
        commands: manifest?.commands,
        permissions: manifest?.permissions,
        enabled: meta.enabled !== false,
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
      if (!info.enabled) continue;
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
    const previous = this.installed.get()[manifest.name];
    const enabled = previous?.enabled !== false;
    this.installed.update((all) => ({
      ...all,
      [manifest.name]: { version: manifest.version, installedAt, path: dest, enabled },
    }));
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      tools: (manifest.tools ?? []).map((t) => t.name),
      commands: manifest.commands,
      permissions: manifest.permissions,
      enabled,
      installedAt,
    };
  }

  /** Clone a git repository and install the plugin it contains. The same
   *  manifest validation as local installs applies. Only well-known public
   *  git hosts are accepted (use local-folder install for anything else). */
  async installFromUrl(url: string): Promise<PluginInfo> {
    const cleaned = url.trim();
    const host = pluginUrlHost(cleaned);
    if (!host) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        "plugin URL must be https://, ssh:// or git@ form",
      );
    }
    if (!ALLOWED_PLUGIN_HOSTS.has(host)) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `plugin host not allowed: ${host} (allowed: ${[...ALLOWED_PLUGIN_HOSTS].join(", ")})`,
      );
    }
    const workdir = mkdtempSync(join(tmpdir(), "senastr-plugin-"));
    try {
      await execFileAsync("git", ["clone", "--depth", "1", cleaned, workdir + "-repo"]);
    } catch (err) {
      rmSync(workdir, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found/i.test(message)) {
        throw new RpcError(ErrorCodes.PLUGIN_INVALID, "git is not installed — cannot install from URL");
      }
      throw new RpcError(ErrorCodes.PLUGIN_INVALID, `git clone failed: ${message.slice(0, 300)}`);
    }
    // The manifest may live at the repo root or one level down.
    const repo = workdir + "-repo";
    let nested = "";
    try {
      nested = readdirSync(repo).find((entry) => entry !== ".git") ?? "";
    } catch {
      nested = "";
    }
    const candidates = nested ? [repo, join(repo, nested)] : [repo];
    let installed: PluginInfo | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        if (existsSync(join(candidate, MANIFEST_FILE))) {
          installed = this.installFromDir(candidate);
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    if (!installed) {
      if (lastError instanceof RpcError) throw lastError;
      throw new RpcError(ErrorCodes.PLUGIN_INVALID, `no ${MANIFEST_FILE} found in ${cleaned}`);
    }
    return installed;
  }

  setEnabled(name: string, enabled: boolean): PluginInfo {
    const meta = this.installed.get()[name];
    if (!meta) throw new RpcError(ErrorCodes.PLUGIN_INVALID, `plugin not installed: ${name}`);
    this.installed.update((all) => ({
      ...all,
      [name]: { ...all[name], enabled },
    }));
    const info = this.list().find((plugin) => plugin.name === name);
    if (!info) throw new RpcError(ErrorCodes.PLUGIN_INVALID, `plugin not installed: ${name}`);
    return info;
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
  const commandNames = new Set<string>();
  for (const command of m.commands ?? []) {
    if (typeof command.name !== "string" || !/^[a-z0-9][a-z0-9:-]*$/i.test(command.name)) {
      invalid("manifest.commands[].name must be a slash alias (letters, digits, ':' or '-')");
    }
    if (commandNames.has(command.name)) invalid(`duplicate plugin command: ${command.name}`);
    commandNames.add(command.name);
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

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { timeout: 120_000 }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

/** Public git hosts accepted for URL installs. */
const ALLOWED_PLUGIN_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
  "git.sr.ht",
]);

/** Extract the hostname from an https/ssh/git@ URL, or null when malformed. */
function pluginUrlHost(cleaned: string): string | null {
  if (cleaned.startsWith("git@")) {
    const rest = cleaned.slice("git@".length);
    const end = rest.search(/[:/]/);
    if (end <= 0) return null;
    return rest.slice(0, end).toLowerCase() || null;
  }
  if (!/^(https:\/\/|ssh:\/\/)/.test(cleaned)) return null;
  try {
    return new URL(cleaned).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
