import { join } from "node:path";
import {
  ErrorCodes,
  Methods,
  PROTOCOL_VERSION,
  RpcError,
  SENASTR_VERSION,
  type GrantScope,
  type ProviderConfig,
  type Session,
} from "@senastr/shared";
import type { RpcServer } from "./server";
import type { SessionStore } from "./sessions";
import type { ProviderStore } from "./providers";
import type { PermissionService } from "./permissions";
import type { ToolRunner } from "./tools/runner";
import type { PluginService } from "./plugins";

export interface MethodContext {
  server: RpcServer;
  dataDir: string;
  sessions: SessionStore;
  providers: ProviderStore;
  permissions: PermissionService;
  tools: ToolRunner;
  plugins: PluginService;
}

/**
 * The host-core method surface. Every method is validated up front and
 * answers through the same RpcServer, so the wire behavior is identical no
 * matter who is on the other end (desktop, demo script, tests).
 */
export function registerMethods(ctx: MethodContext): void {
  const { server, sessions, providers, permissions, tools, plugins } = ctx;

  // --- host -----------------------------------------------------------------
  server.onMethod(Methods.hostPing, () => ({
    ok: true,
    version: SENASTR_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dataDir: ctx.dataDir,
  }));

  server.onMethod(Methods.hostToolsList, () => tools.listTools());

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

  server.onMethod(Methods.sessionDelete, (params: { id: string }) => {
    const id = requireString(params, "id");
    sessions.delete(id);
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

  server.onMethod(Methods.pluginInstall, (params: { dir: string }) => {
    const dir = requireString(params, "dir");
    return plugins.installFromDir(dir);
  });

  server.onMethod(Methods.pluginUninstall, (params: { name: string }) => {
    const name = requireString(params, "name");
    plugins.uninstall(name);
    return { ok: true };
  });
}

function requireString(params: unknown, field: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || !value) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, `${field} is required`);
  }
  return value;
}

export { join };
