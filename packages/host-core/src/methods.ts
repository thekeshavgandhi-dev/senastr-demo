import { join } from "node:path";
import {
  ErrorCodes,
  Methods,
  PROTOCOL_VERSION,
  RpcError,
  SENASTR_VERSION,
  isThinkingLevel,
  type AppSettings,
  type ChatMessage,
  type ExternalAgentSource,
  type ExternalSessionSummary,
  type GrantScope,
  type MessageAttachment,
  type McpServerInput,
  type ProjectContext,
  type ProviderConfig,
  type ProviderDiscoveryInput,
  type ScheduledRun,
  type ScheduledTaskInput,
  type Session,
  type SessionMode,
  type SkillInput,
  type SubagentInput,
  type ProjectGroupInput,
  type ProjectInput,
  type ProviderKind,
  type ThinkingLevel,
  type TurnStopReason,
} from "@senastr/shared";
import type { RpcServer } from "./server";
import type { SessionStore } from "./sessions";
import type { ProviderStore } from "./providers";
import type { PermissionService } from "./permissions";
import type { ToolRunner } from "./tools/runner";
import type { PluginService } from "./plugins";
import type { SkillService } from "./skills";
import type { McpService } from "./mcp";
import type { SubagentService } from "./subagents";
import type { ScheduledService } from "./scheduled";
import type { ReviewStore } from "./review";
import type { InstructionService } from "./instructions";
import type { RevisionService } from "./revisions";
import type { ProjectService } from "./projects";
import type { SettingsService } from "./settings";
import type { StatsService } from "./stats";
import type { AttachmentService } from "./attachments";
import type { ScratchService } from "./scratch";
import { convertExternalSession, scanExternalSessions, scanModelConfigs } from "./importers";
import { indexProject } from "./fs-index";
import { builtinPaletteItems, searchCommands } from "@senastr/shared";

export interface MethodContext {
  server: RpcServer;
  dataDir: string;
  sessions: SessionStore;
  providers: ProviderStore;
  permissions: PermissionService;
  tools: ToolRunner;
  plugins: PluginService;
  skills: SkillService;
  mcp: McpService;
  subagents: SubagentService;
  scheduled: ScheduledService;
  review: ReviewStore;
  instructions: InstructionService;
  revisions: RevisionService;
  projects: ProjectService;
  settings: SettingsService;
  stats: StatsService;
  attachments: AttachmentService;
  scratch: ScratchService;
}

/**
 * The host-core method surface. Every method is validated up front and
 * answers through the same RpcServer, so the wire behavior is identical no
 * matter who is on the other end (desktop, demo script, tests).
 */
export function registerMethods(ctx: MethodContext): void {
  const {
    server,
    sessions,
    providers,
    permissions,
    tools,
    plugins,
    skills,
    mcp,
    subagents,
    scheduled,
    review,
    instructions,
    revisions,
    projects,
    settings,
    stats,
    attachments,
    scratch,
  } = ctx;

  // --- host -----------------------------------------------------------------
  server.onMethod(Methods.hostPing, () => ({
    ok: true,
    version: SENASTR_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dataDir: ctx.dataDir,
  }));

  server.onMethod(Methods.hostToolsList, (params?: { sessionId?: string }) =>
    tools.listTools(typeof params?.sessionId === "string" ? params.sessionId : undefined),
  );

  // --- sessions ---------------------------------------------------------------
  server.onMethod(Methods.sessionList, () => sessions.list());

  server.onMethod(Methods.sessionCreate, (params: { title?: string; projectPath?: string | null }): Session =>
    sessions.create(params ?? {}),
  );

  server.onMethod(Methods.sessionGet, (params: { id: string }): Session => {
    const id = requireString(params, "id");
    return sessions.get(id);
  });

  server.onMethod(Methods.sessionRename, (params: { id: string; title: string }): Session => {
    const id = requireString(params, "id");
    const title = requireString(params, "title");
    return sessions.rename(id, title);
  });

  server.onMethod(Methods.sessionSetProject, (params: { id: string; projectPath: string | null }): Session => {
    const id = requireString(params, "id");
    const projectPath =
      params?.projectPath === null || typeof params?.projectPath === "string" ? params.projectPath : null;
    return sessions.setProject(id, projectPath);
  });

  server.onMethod(Methods.sessionSetMode, (params: { id: string; mode: SessionMode }): Session => {
    const id = requireString(params, "id");
    return sessions.setMode(id, params.mode);
  });

  server.onMethod(Methods.sessionDelete, (params: { id: string }) => {
    const id = requireString(params, "id");
    sessions.delete(id);
    review.purge(id);
    return { ok: true };
  });

  server.onMethod(Methods.sessionAppendMessages, (params: { id: string; messages: unknown[] }): Session => {
    const id = requireString(params, "id");
    return sessions.appendMessages(id, params.messages as never);
  });

  // --- providers --------------------------------------------------------------
  server.onMethod(Methods.providerList, () => providers.list());

  server.onMethod(Methods.providerGet, (params: { id: string }): ProviderConfig => {
    // NOTE: returns the full config including the API key. Only the Electron
    // main process calls this; the renderer only ever sees provider/list.
    const id = requireString(params, "id");
    return providers.get(id);
  });

  server.onMethod(Methods.providerSet, (params: { provider: ProviderConfig }) => {
    const provider = params?.provider as ProviderConfig | undefined;
    if (!provider) throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider is required");
    return providers.set(provider);
  });

  server.onMethod(Methods.providerDelete, (params: { id: string }) => {
    const id = requireString(params, "id");
    providers.delete(id);
    return { ok: true };
  });

  server.onMethod(Methods.providerTest, (params: { id: string }) => {
    const id = requireString(params, "id");
    return providers.test(id);
  });

  server.onMethod(Methods.providerDiscoverModels, (params: { input: ProviderDiscoveryInput }) => {
    if (!params?.input) throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider connection is required");
    return providers.discover(params.input);
  });

  // --- skills ----------------------------------------------------------------
  server.onMethod(Methods.skillList, (params?: { level?: "global" | "project"; projectPath?: string }) =>
    skills.list(params ?? {}),
  );
  server.onMethod(Methods.skillActive, (params?: { projectPath?: string | null }) =>
    skills.active(params?.projectPath),
  );
  server.onMethod(Methods.skillSet, (params: { skill: SkillInput }) => {
    if (!params?.skill) throw new RpcError(ErrorCodes.INVALID_PARAMS, "skill is required");
    return skills.set(params.skill);
  });
  server.onMethod(
    Methods.skillSetEnabled,
    (params: { id: string; enabled: boolean; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      return skills.setEnabled(id, Boolean(params.enabled), params);
    },
  );
  server.onMethod(
    Methods.skillDelete,
    (params: { id: string; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      skills.delete(id, params);
      return { ok: true };
    },
  );

  // --- MCP -------------------------------------------------------------------
  server.onMethod(Methods.mcpList, (params?: { level?: "global" | "project"; projectPath?: string }) => ({
    servers: mcp.list(params ?? {}),
    statuses: mcp.listStatuses(params ?? {}),
  }));
  server.onMethod(Methods.mcpSet, (params: { server: McpServerInput }) => {
    if (!params?.server) throw new RpcError(ErrorCodes.INVALID_PARAMS, "MCP server is required");
    return mcp.set(params.server);
  });
  server.onMethod(
    Methods.mcpSetEnabled,
    (params: { id: string; enabled: boolean; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      return mcp.setEnabled(id, Boolean(params.enabled), params);
    },
  );
  server.onMethod(
    Methods.mcpDelete,
    (params: { id: string; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      mcp.delete(id, params);
      return { ok: true };
    },
  );
  server.onMethod(
    Methods.mcpTest,
    (params: { id: string; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      return mcp.test(id, params);
    },
  );

  // --- tools & permissions -----------------------------------------------------
  server.onMethod(Methods.toolRun, (params: { sessionId: string; tool: string; args: Record<string, unknown> }) => {
    const sessionId = requireString(params, "sessionId");
    const tool = requireString(params, "tool");
    const args =
      params?.args && typeof params.args === "object" && !Array.isArray(params.args)
        ? (params.args as Record<string, unknown>)
        : {};
    return tools.run({ sessionId, tool, args });
  });

  server.onMethod(Methods.permissionRespond, (params: { requestId: string; allow: boolean; remember?: GrantScope | null }) => {
    const requestId = requireString(params, "requestId");
    const allow = Boolean(params?.allow);
    const remember: GrantScope | null =
      params?.remember === "session" || params?.remember === "always" ? params.remember : null;
    const handled = permissions.respond(requestId, allow, remember);
    return { handled };
  });

  server.onMethod(Methods.permissionList, () => permissions.list());

  server.onMethod(Methods.permissionClear, (params: { sessionId?: string; tool?: string }) => {
    permissions.clear(
      typeof params?.sessionId === "string" ? params.sessionId : undefined,
      typeof params?.tool === "string" ? params.tool : undefined,
    );
    return { ok: true };
  });

  // --- plugins -----------------------------------------------------------------
  server.onMethod(Methods.pluginList, () => plugins.list());

  server.onMethod(Methods.pluginInstall, (params: { dir?: string; url?: string }) => {
    if (typeof params?.url === "string" && params.url.trim()) {
      return plugins.installFromUrl(params.url);
    }
    const dir = requireString(params, "dir");
    return plugins.installFromDir(dir);
  });

  server.onMethod(Methods.pluginUninstall, (params: { name: string }) => {
    const name = requireString(params, "name");
    plugins.uninstall(name);
    return { ok: true };
  });

  server.onMethod(Methods.pluginSetEnabled, (params: { name: string; enabled: boolean }) => {
    const name = requireString(params, "name");
    return plugins.setEnabled(name, Boolean(params.enabled));
  });

  // --- subagents ---------------------------------------------------------------
  server.onMethod(Methods.subagentList, (params?: { level?: "global" | "project"; projectPath?: string }) =>
    subagents.list(params ?? {}),
  );
  server.onMethod(Methods.subagentActive, (params?: { projectPath?: string | null }) =>
    subagents.active(params?.projectPath),
  );
  server.onMethod(Methods.subagentSet, (params: { subagent: SubagentInput }) => {
    if (!params?.subagent) throw new RpcError(ErrorCodes.INVALID_PARAMS, "subagent is required");
    return subagents.set(params.subagent);
  });
  server.onMethod(
    Methods.subagentSetEnabled,
    (params: { id: string; enabled: boolean; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      return subagents.setEnabled(id, Boolean(params.enabled), params);
    },
  );
  server.onMethod(
    Methods.subagentDelete,
    (params: { id: string; level?: "global" | "project"; projectPath?: string }) => {
      const id = requireString(params, "id");
      subagents.delete(id, params);
      return { ok: true };
    },
  );

  // --- scheduled tasks -----------------------------------------------------------
  server.onMethod(Methods.scheduledList, () => scheduled.list());
  server.onMethod(Methods.scheduledSet, (params: { task: ScheduledTaskInput }) => {
    if (!params?.task) throw new RpcError(ErrorCodes.INVALID_PARAMS, "task is required");
    return scheduled.set(params.task);
  });
  server.onMethod(Methods.scheduledDelete, (params: { id: string }) => {
    const id = requireString(params, "id");
    scheduled.delete(id);
    return { ok: true };
  });
  server.onMethod(Methods.scheduledSetEnabled, (params: { id: string; enabled: boolean }) => {
    const id = requireString(params, "id");
    return scheduled.setEnabled(id, Boolean(params.enabled));
  });
  server.onMethod(Methods.scheduledRuns, (params: { taskId: string }) => {
    const taskId = requireString(params, "taskId");
    return scheduled.runsFor(taskId);
  });
  server.onMethod(Methods.scheduledRecordRun, (params: { run: ScheduledRun; claim?: { taskId: string; sessionId: string } }) => {
    if (params?.claim) {
      const { taskId, sessionId } = params.claim;
      if (typeof taskId === "string" && typeof sessionId === "string") return scheduled.claim(taskId, sessionId);
    }
    if (!params?.run) throw new RpcError(ErrorCodes.INVALID_PARAMS, "run is required");
    return scheduled.recordRun(params.run);
  });

  // --- review snapshots ------------------------------------------------------------
  server.onMethod(Methods.reviewList, (params: { sessionId: string }) => {
    const sessionId = requireString(params, "sessionId");
    return review.list(sessionId);
  });
  server.onMethod(Methods.reviewGet, (params: { sessionId: string; snapshotId: string }) => {
    const sessionId = requireString(params, "sessionId");
    const snapshotId = requireString(params, "snapshotId");
    return review.get(sessionId, snapshotId);
  });
  server.onMethod(Methods.reviewPurge, (params: { sessionId: string }) => {
    const sessionId = requireString(params, "sessionId");
    review.purge(sessionId);
    return { ok: true };
  });
  server.onMethod(Methods.reviewRollback, (params: { sessionId: string; snapshotId: string }) => {
    const sessionId = requireString(params, "sessionId");
    const snapshotId = requireString(params, "snapshotId");
    const snapshot = review.get(sessionId, snapshotId);
    if (snapshot.truncated) {
      throw new RpcError(ErrorCodes.HOST_ERROR, "snapshot is truncated — rollback is unsafe");
    }
    const output = tools.rollbackFile(sessionId, snapshot.path, snapshot.before);
    return { ok: true, output };
  });


  server.onMethod(
    Methods.sessionReplaceMessages,
    (params: { id: string; messages: ChatMessage[] }) => {
      const id = requireString(params, "id");
      if (!Array.isArray(params?.messages)) {
        throw new RpcError(ErrorCodes.INVALID_PARAMS, "messages must be an array");
      }
      return sessions.replaceMessages(id, params.messages);
    },
  );

  // --- session fork / thinking / scratch --------------------------------------
  server.onMethod(Methods.sessionFork, (params: { id: string; title?: string; messageCount?: number }) => {
    const id = requireString(params, "id");
    return sessions.fork(id, { title: params?.title, messageCount: params?.messageCount });
  });

  server.onMethod(Methods.sessionSetThinking, (params: { id: string; level: ThinkingLevel | null }) => {
    const id = requireString(params, "id");
    const level = params?.level;
    if (level !== null && !isThinkingLevel(level)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `invalid thinking level: ${String(level)}`);
    }
    return sessions.setThinkingLevel(id, level ?? null);
  });

  server.onMethod(Methods.sessionScratch, (params: { sessionId: string; create?: boolean }) => {
    const sessionId = requireString(params, "sessionId");
    // Only sessions that exist get a scratch directory.
    sessions.get(sessionId);
    return scratch.path(sessionId, Boolean(params?.create));
  });

  // --- revisions ---------------------------------------------------------------
  server.onMethod(Methods.sessionRevisionsList, (params: { sessionId: string }) =>
    revisions.list(requireString(params, "sessionId")),
  );

  server.onMethod(
    Methods.sessionRevisionsSave,
    (params: { sessionId: string; label?: string }) => {
      const sessionId = requireString(params, "sessionId");
      const session = sessions.get(sessionId);
      return revisions.save({
        sessionId,
        label: params?.label,
        title: session.title,
        mode: session.mode,
        messages: session.messages,
      });
    },
  );

  server.onMethod(
    Methods.sessionRevisionsActivate,
    (params: { sessionId: string; revisionId: string }) => {
      const sessionId = requireString(params, "sessionId");
      const revisionId = requireString(params, "revisionId");
      const revision = revisions.get(sessionId, revisionId) as {
        messages: unknown[];
        sessionTitle: string;
      };
      const restored = sessions.replaceMessages(sessionId, revision.messages as never);
      if (revision.sessionTitle) sessions.rename(sessionId, revision.sessionTitle);
      return sessions.get(restored.id);
    },
  );

  server.onMethod(
    Methods.sessionRevisionsDelete,
    (params: { sessionId: string; revisionId: string }) => {
      revisions.delete(requireString(params, "sessionId"), requireString(params, "revisionId"));
      return { ok: true };
    },
  );

  // --- external session import ---------------------------------------------------
  server.onMethod(
    Methods.sessionImportScan,
    (params?: { sources?: ExternalAgentSource[] }) => scanExternalSessions({ sources: params?.sources }),
  );

  server.onMethod(
    Methods.sessionImportRun,
    (params: { sessions: ExternalSessionSummary[]; projectPathOverride?: string | null }) => {
      const wanted = Array.isArray(params?.sessions) ? params.sessions : [];
      const imported: Session[] = [];
      const errors: Array<{ externalId: string; error: string }> = [];
      for (const summary of wanted.slice(0, 200)) {
        try {
          if (!summary || typeof summary.source !== "string" || typeof summary.externalId !== "string") {
            throw new Error("invalid import descriptor");
          }
          const converted = convertExternalSession(summary);
          if (sessions.exists(converted.id)) continue; // idempotent re-import
          const created = sessions.create({
            id: converted.id,
            title: converted.title,
            projectPath:
              typeof params.projectPathOverride === "string" && params.projectPathOverride
                ? params.projectPathOverride
                : converted.projectPath,
            mode: "build",
            createdAt: converted.createdAt,
            updatedAt: converted.updatedAt,
            messages: converted.messages,
          });
          imported.push(created);
        } catch (err) {
          errors.push({
            externalId: String(summary?.externalId ?? "?"),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { imported: imported.length, sessions: imported.map((s) => ({ ...s, messages: [] })), errors };
    },
  );

  server.onMethod(Methods.modelConfigImportScan, () => ({ entries: scanModelConfigs() }));

  server.onMethod(
    Methods.modelConfigImportRun,
    (params: { entries: Array<{ providerId: string; providerLabel: string; model: string; baseUrl?: string; kind?: ProviderKind }> }) => {
      const entries = Array.isArray(params?.entries) ? params.entries : [];
      const created: string[] = [];
      for (const entry of entries.slice(0, 50)) {
        const provider = providers.get(entry.providerId);
        if (provider) {
          // Existing provider: merge the model in rather than duplicating it.
          const models = new Set(provider.models);
          models.add(entry.model);
          providers.set({ ...provider, models: [...models], enabled: true });
          created.push(provider.id);
          continue;
        }
        providers.set({
          id: entry.providerId,
          kind: entry.kind ?? (entry.baseUrl?.includes("anthropic") ? "anthropic" : "openai"),
          label: entry.providerLabel,
          baseUrl: entry.baseUrl,
          models: [entry.model],
          defaultModel: entry.model,
        });
        created.push(entry.providerId);
      }
      return { ok: true, providers: created };
    },
  );

  // --- attachments ------------------------------------------------------------------
  server.onMethod(Methods.attachmentAdd, (params: {
    sessionId: string;
    kind?: "image" | "file";
    name?: string;
    mimeType?: string;
    dataBase64?: string;
    path?: string;
    text?: string;
  }): MessageAttachment => {
    const sessionId = requireString(params, "sessionId");
    sessions.get(sessionId);
    return attachments.add({
      sessionId,
      kind: params.kind === "image" ? "image" : "file",
      name: params.name ?? "",
      mimeType: params.mimeType ?? "application/octet-stream",
      dataBase64: params.dataBase64,
      path: params.path,
      text: params.text,
    });
  });

  server.onMethod(Methods.attachmentRead, (params: { storeId: string }) =>
    attachments.read(requireString(params, "storeId")),
  );

  server.onMethod(Methods.attachmentDelete, (params: { storeId: string }) => {
    attachments.delete(requireString(params, "storeId"));
    return { ok: true };
  });

  // --- projects -----------------------------------------------------------------------
  server.onMethod(Methods.projectList, () => {
    const state = projects.list();
    const counts = new Map<string, number>();
    for (const meta of sessions.list()) {
      if (!meta.projectPath) continue;
      counts.set(meta.projectPath, (counts.get(meta.projectPath) ?? 0) + 1);
    }
    return {
      projects: state.projects.map((p) => ({ ...p, sessionCount: counts.get(p.path) ?? 0 })),
      groups: state.groups,
    };
  });

  server.onMethod(Methods.projectAdd, (params: ProjectInput) => projects.add(params));
  server.onMethod(Methods.projectUpdate, (params: ProjectInput) => projects.update(params));
  server.onMethod(Methods.projectRemove, (params: { path: string }) => {
    projects.remove(requireString(params, "path"));
    return { ok: true };
  });
  server.onMethod(Methods.projectGroupList, () => projects.list().groups);
  server.onMethod(Methods.projectGroupSet, (params: ProjectGroupInput) => projects.setGroup(params));
  server.onMethod(Methods.projectGroupDelete, (params: { id: string }) => {
    projects.deleteGroup(requireString(params, "id"));
    return { ok: true };
  });

  // --- stats --------------------------------------------------------------------------
  server.onMethod(
    Methods.statsUsage,
    (params?: { startDate?: number; endDate?: number; bucket?: "day" | "week" | "month"; sessionId?: string }) =>
      stats.history(params ?? {}),
  );

  server.onMethod(
    Methods.statsRecordUsage,
    (params: {
      sessionId: string;
      at?: number;
      providerId?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      stopReason?: TurnStopReason;
    }) => stats.record(params),
  );

  // --- settings ------------------------------------------------------------------------
  server.onMethod(Methods.settingsGet, (): AppSettings => settings.get());
  server.onMethod(Methods.settingsSet, (params: Partial<AppSettings>): AppSettings => settings.set(params ?? {}));

  // --- workspace ------------------------------------------------------------------------
  server.onMethod(Methods.fsIndex, (params: { projectPath: string; force?: boolean; limit?: number }) => {
    const projectPath = requireString(params, "projectPath");
    return indexProject(projectPath, { force: params?.force, limit: params?.limit });
  });

  // --- commands --------------------------------------------------------------------------
  server.onMethod(Methods.commandList, (params?: { query?: string; limit?: number }) => {
    const builtin = builtinPaletteItems();
    const pluginCommands = plugins
      .list()
      .filter((p) => p.enabled)
      .flatMap((p) =>
        (p.commands ?? []).map((command) => ({
          id: `plugin.${p.name}.${command.name}`,
          title: command.title ?? command.name,
          category: p.name,
          keywords: [command.name, p.name, ...(command.keywords ?? [])],
          source: "plugin" as const,
          plugin: p.name,
          slash: command.name,
        })),
      );
    const skillCommands = skills.list({}).flatMap((skill) => {
      if (!skill.enabled) return [];
      const skillSlash = `skill:${skill.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
      return [
        {
          id: `skill.${skill.id}`,
          title: `Use skill: ${skill.name}`,
          category: "Skills",
          keywords: [skill.name, ...(skill.description ? skill.description.split(/\s+/).slice(0, 8) : [])],
          source: "skill" as const,
          slash: skillSlash,
        },
      ];
    });
    const merged = [...builtin, ...pluginCommands, ...skillCommands];
    return { commands: searchCommands(merged, params ?? {}), total: merged.length };
  });

  // --- project instructions ----------------------------------------------------------
  server.onMethod(Methods.projectGetContext, (params?: { projectPath?: string | null }): ProjectContext => {
    const projectPath = typeof params?.projectPath === "string" ? params.projectPath : null;
    return instructions.get(projectPath);
  });
  server.onMethod(
    Methods.projectSetContext,
    (params: { projectPath?: string | null; instructions?: string; memory?: string }): ProjectContext => {
      const projectPath = typeof params?.projectPath === "string" ? params.projectPath : null;
      return instructions.set(projectPath, params?.instructions ?? "", params?.memory ?? "");
    },
  );
}

function requireString(params: unknown, field: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || !value) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} is required`);
  }
  return value;
}

export { join };
