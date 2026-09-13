import { BUILTIN_TOOLS, ErrorCodes, RpcError, type ToolDefinition, type ToolResult } from "@senastr/shared";
import type { PermissionService } from "../permissions";
import type { SessionStore } from "../sessions";
import type { PluginService } from "../plugins";
import { listDirTool, readFileTool, resolveProjectPath, writeFileTool } from "./fs";
import { runShell } from "./shell";

export interface ToolRunParams {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Executes agent tool calls against the project.
 *
 * Flow per call (ADR 0005):
 *   1. resolve the session's project root (tools are project-confined)
 *   2. look up the tool (builtin or plugin-declared)
 *   3. risk "read" → execute; otherwise require a grant, else block on an
 *      interactive permission request (120s timeout → deny)
 *   4. execute and return a ToolResult (never throw across the wire)
 */
export class ToolRunner {
  constructor(
    private readonly sessions: SessionStore,
    private readonly permissions: PermissionService,
    private readonly plugins: PluginService,
  ) {}

  listTools(): ToolDefinition[] {
    const pluginTools: ToolDefinition[] = this.plugins.list().flatMap((p) => {
      const manifest = this.plugins.readManifest(p.name);
      return (manifest?.tools ?? []).map<ToolDefinition>((t) => ({
        name: t.name,
        description: `[${p.name}] ${t.description}`,
        parameters: t.args ?? { type: "object", properties: {} },
        risk: "exec",
        source: "plugin",
        plugin: p.name,
      }));
    });
    return [...BUILTIN_TOOLS, ...pluginTools];
  }

  async run(params: ToolRunParams): Promise<ToolResult> {
    const started = Date.now();
    const finish = (ok: boolean, payload: { output?: string; error?: string }): ToolResult => ({
      ok,
      ...payload,
      durationMs: Date.now() - started,
    });

    try {
      const session = this.sessions.get(params.sessionId);
      const project = resolveProjectPath(session.projectPath);
      const tool = this.listTools().find((t) => t.name === params.tool);
      if (!tool) {
        return finish(false, { error: `unknown tool: ${params.tool}` });
      }

      if (tool.risk !== "read" && !this.permissions.hasGrant(session.id, tool.name)) {
        const summary = this.summarize(tool.name, params.args);
        const decision = await this.permissions.request({
          sessionId: session.id,
          tool: tool.name,
          args: params.args,
          summary,
        });
        if (!decision.allowed) {
          const error = decision.timedOut
            ? `permission request timed out after 120s — denied`
            : "permission denied by user";
          return finish(false, { error });
        }
      }

      const output = await this.execute(tool, project, params.args);
      return finish(true, { output });
    } catch (err) {
      const message = err instanceof RpcError ? err.message : err instanceof Error ? err.message : String(err);
      return finish(false, { error: message });
    }
  }

  private async execute(
    tool: ToolDefinition,
    project: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (tool.name) {
      case "read_file":
        return readFileTool(project, args);
      case "write_file":
        return writeFileTool(project, args);
      case "list_dir":
        return listDirTool(project, args);
      case "run_command":
        return (await runShell(project, args)).output;
      default: {
        if (tool.source !== "plugin" || !tool.plugin) {
          throw new RpcError(ErrorCodes.TOOL_NOT_FOUND, `tool not executable: ${tool.name}`);
        }
        const found = this.plugins.findTool(tool.name);
        if (!found) throw new RpcError(ErrorCodes.TOOL_NOT_FOUND, `plugin tool disappeared: ${tool.name}`);
        const command = expandTemplate(found.def.command, args);
        return (await runShell(project, { command })).output;
      }
    }
  }

  private summarize(tool: string, args: Record<string, unknown>): string {
    const path = typeof args.path === "string" ? args.path : undefined;
    const command = typeof args.command === "string" ? args.command : undefined;
    const content = typeof args.content === "string" ? args.content : undefined;
    if (path) return `${tool} → ${path}`;
    if (command) return `${tool} → ${command.slice(0, 120)}`;
    if (content !== undefined) return `${tool} → ${content.length} characters`;
    return `${tool} ${JSON.stringify(args).slice(0, 120)}`;
  }
}

/** Substitute `{arg}` placeholders with shell-quoted argument values. */
export function expandTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = args[key];
    if (value === undefined) return match;
    if (typeof value === "string") return shellQuote(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return shellQuote(JSON.stringify(value));
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
