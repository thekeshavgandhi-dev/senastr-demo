/**
 * Client-side preferences. Like the reference app, sidebar/UX preferences
 * (pins, archive, collapse, appearance, modes) live in localStorage — the
 * host-core remains the only writer of real workspace state.
 */

export type ThemePref = "system" | "light" | "dark";
export type PermissionMode = "ask" | "accept-edits" | "auto";
export type AgentMode = "build" | "plan" | "goal";
export type SessionSort = "recent" | "name" | "created";

export interface SessionPrefs {
  pinned?: boolean;
  archived?: boolean;
  mode?: AgentMode;
  permissionMode?: PermissionMode;
  /** Reasoning level override for this session (host records the durable one). */
  thinkingLevel?: string;
}

export interface ProjectMeta {
  /** User display name override. */
  name?: string;
  collapsed?: boolean;
  pinned?: boolean;
}

export interface WorkPanelState {
  open: boolean;
  tab: string;
}

const K = {
  theme: "senastr.theme",
  fontScale: "senastr.fontScale",
  enterToSend: "senastr.enterToSend",
  sidebarCollapsed: "senastr.sidebarCollapsed",
  workPanel: "senastr.workPanel",
  sessionPrefs: "senastr.sessionPrefs",
  projectMeta: "senastr.projectMeta",
  sessionSort: "senastr.sessionSort",
  defaultPermissionMode: "senastr.defaultPermissionMode",
  defaultAgentMode: "senastr.defaultAgentMode",
  largePasteThreshold: "senastr.largePasteThreshold",
  drafts: "senastr.drafts",
  settingsTab: "senastr.settingsTab",
  onboardingDone: "senastr.onboardingDone",
  language: "senastr.language",
  thinkingLevel: "senastr.thinkingLevel",
  projectGroups: "senastr.projectGroups",
  updateChannel: "senastr.updateChannel",
} as const;

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) } as T;
  } catch {
    return fallback;
  }
}

export function loadRaw<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* non-fatal */
  }
}

export const prefs = {
  get theme(): ThemePref {
    return loadRaw<ThemePref>(K.theme, "system");
  },
  set theme(v: ThemePref) {
    saveJson(K.theme, v);
  },
  get fontScale(): number {
    const v = loadRaw<number>(K.fontScale, 1);
    return typeof v === "number" && v >= 0.85 && v <= 1.25 ? v : 1;
  },
  set fontScale(v: number) {
    saveJson(K.fontScale, v);
  },
  get enterToSend(): boolean {
    return loadRaw<boolean>(K.enterToSend, true);
  },
  set enterToSend(v: boolean) {
    saveJson(K.enterToSend, v);
  },
  get sidebarCollapsed(): boolean {
    return loadRaw<boolean>(K.sidebarCollapsed, false);
  },
  set sidebarCollapsed(v: boolean) {
    saveJson(K.sidebarCollapsed, v);
  },
  get workPanel(): WorkPanelState {
    return loadJson<WorkPanelState>(K.workPanel, { open: false, tab: "review" });
  },
  set workPanel(v: WorkPanelState) {
    saveJson(K.workPanel, v);
  },
  get sessionPrefs(): Record<string, SessionPrefs> {
    return loadRaw<Record<string, SessionPrefs>>(K.sessionPrefs, {});
  },
  set sessionPrefs(v: Record<string, SessionPrefs>) {
    saveJson(K.sessionPrefs, v);
  },
  get projectMeta(): Record<string, ProjectMeta> {
    return loadRaw<Record<string, ProjectMeta>>(K.projectMeta, {});
  },
  set projectMeta(v: Record<string, ProjectMeta>) {
    saveJson(K.projectMeta, v);
  },
  get sessionSort(): SessionSort {
    return loadRaw<SessionSort>(K.sessionSort, "recent");
  },
  set sessionSort(v: SessionSort) {
    saveJson(K.sessionSort, v);
  },
  get defaultPermissionMode(): PermissionMode {
    return loadRaw<PermissionMode>(K.defaultPermissionMode, "ask");
  },
  set defaultPermissionMode(v: PermissionMode) {
    saveJson(K.defaultPermissionMode, v);
  },
  get defaultAgentMode(): AgentMode {
    return loadRaw<AgentMode>(K.defaultAgentMode, "build");
  },
  set defaultAgentMode(v: AgentMode) {
    saveJson(K.defaultAgentMode, v);
  },
  get largePasteThreshold(): number {
    return loadRaw<number>(K.largePasteThreshold, 2000);
  },
  set largePasteThreshold(v: number) {
    saveJson(K.largePasteThreshold, v);
  },
  get drafts(): Record<string, string> {
    return loadRaw<Record<string, string>>(K.drafts, {});
  },
  set drafts(v: Record<string, string>) {
    saveJson(K.drafts, v);
  },
  get settingsTab(): string {
    return loadRaw<string>(K.settingsTab, "models");
  },
  set settingsTab(v: string) {
    saveJson(K.settingsTab, v);
  },
  /** UI language tag. The host stores the durable copy; this one paints first. */
  get language(): string {
    return loadRaw<string>(K.language, "en");
  },
  set language(v: string) {
    saveJson(K.language, v);
  },
  /** Default reasoning level for new sessions (empty = model default). */
  get thinkingLevel(): string {
    return loadRaw<string>(K.thinkingLevel, "");
  },
  set thinkingLevel(v: string) {
    saveJson(K.thinkingLevel, v);
  },
};

/** Resolve effective theme, following the OS when set to "system". */
export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Rough token estimate (~4 chars per token) for context-usage display. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

export function projectDisplayName(path: string, meta?: ProjectMeta): string {
  if (meta?.name?.trim()) return meta.name.trim();
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function isDefaultTitle(title?: string | null): boolean {
  const t = (title || "").trim().toLowerCase();
  return !t || t === "new session" || t === "new task" || t === "new chat";
}
