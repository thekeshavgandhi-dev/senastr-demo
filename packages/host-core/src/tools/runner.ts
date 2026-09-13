import { BUILTIN_TOOLS, ErrorCodes, RpcError, type ToolDefinition, type ToolResult } from "@senastr/shared";
import type { PermissionService } from "../permissions";
import type { SessionStore } from "../sessions";
import type { PluginService } from "../plugins";
import type { McpService } from "../mcp";
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
 * Builtins, enabled plugin tools, and tools discovered from active MCP servers
 * all travel through the same project lookup and permission gateway.
 */
export class ToolRunner {
  constructor(
    private readonly sessions: SessionStore,
    private readonly permissions: PermissionService,
    private readonly plugins: PluginService,
    private readonly mcp?: McpService,
  ) {}

  async listTools(sessionId?: string): Promise<ToolDefinition[]> {
    const pluginTools: ToolDefinition[] = this.plugins
      .list()
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) => {
        const manifest = this.plugins.readManifest(plugin.name);
        return (manifest?.tools ?? []).map<ToolDefinition>((tool) => ({
          name: tool.name,
          description: `[${plugin.name}] ${tool.description}`,
          parameters: tool.args ?? { type: "object", properties: {} },
          risk: "exec",
          source: "plugin",
          plugin: plugin.name,
        }));
      });
    let mcpTools: ToolDefinition[] = [];
    if (this.mcp && sessionId) {
      const session = this.sessions.get(sessionId);
      mcpTools = await this.mcp.listToolDefinitions(session.projectPath);
    }
    return [...BUILTIN_TOOLS, ...pluginTools, ...mcpTools];
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
      const tool = (await this.listTools(params.sessionId)).find((candidate) => candidate.name === params.tool);
      if (!tool) return finish(false, { error: `unknown tool: ${params.tool}` });

      if (tool.risk !== "read" && !this.permissions.hasGrant(session.id, tool.name)) {
        const decision = await this.permissions.request({
          sessionId: session.id,
          tool: tool.name,
          args: params.args,
          summary: this.summarize(tool, params.args),
        });
        if (!decision.allowed) {
          return finish(false, {
            error: decision.timedOut
              ? "permission request timed out after 120s — denied"
              : "permission denied by user",
          });
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
        if (tool.source === "mcp" && this.mcp) {
          return this.mcp.callTool(tool.name, args, project);
        }
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

  private summarize(tool: ToolDefinition, args: Record<string, unknown>): string {
    if (tool.source === "mcp") return `${tool.description} → ${JSON.stringify(args).slice(0, 100)}`;
    const path = typeof args.path === "string" ? args.path : undefined;
    const command = typeof args.command === "string" ? args.command : undefined;
    const content = typeof args.content === "string" ? args.content : undefined;
    if (path) return `${tool.name} → ${path}`;
    if (command) return `${tool.name} → ${command.slice(0, 120)}`;
    if (content !== undefined) return `${tool.name} → ${content.length} characters`;
    return `${tool.name} ${JSON.stringify(args).slice(0, 120)}`;
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
