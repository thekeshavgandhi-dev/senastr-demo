/**
 * Command catalogue (parity: pi-desktop `builtin-commands.ts` +
 * `commandPalette/search` + `composer/commands`).
 *
 * One source of truth feeds three surfaces:
 *   - the command palette (Ctrl/Cmd+Shift+P),
 *   - the composer "/" menu,
 *   - plugin/skill contributed commands (optional `source`).
 */

export type CommandSource = "builtin" | "plugin" | "skill";

export interface CommandItem {
  id: string;
  title: string;
  category?: string;
  keywords: string[];
  source: CommandSource;
  /** Composer slash alias, unique across the merged command namespace. */
  slash?: string;
  /** Plugin-provided commands name their plugin. */
  plugin?: string;
  /** Optional conflict note shown in the palette. */
  requiresProject?: boolean;
}

export interface ComposerCommand {
  name: string;
  kind: "builtin" | "plugin" | "skill";
  title: string;
  description?: string;
  id?: string;
}

export const BUILTIN_COMMANDS: CommandItem[] = [
  {
    id: "builtin.session.new",
    title: "New task",
    category: "Session",
    keywords: ["new", "chat", "task", "session"],
    source: "builtin",
    slash: "new",
  },
  {
    id: "builtin.agent.compact",
    title: "Compact conversation context",
    category: "Session",
    keywords: ["compact", "context", "tokens", "history"],
    source: "builtin",
    slash: "compact",
  },
  {
    id: "builtin.mode.agent",
    title: "Switch to Agent mode",
    category: "Session",
    keywords: ["mode", "agent", "build", "default"],
    source: "builtin",
    slash: "agent-mode",
  },
  {
    id: "builtin.mode.plan",
    title: "Switch to Plan mode",
    category: "Session",
    keywords: ["mode", "plan", "planning", "review"],
    source: "builtin",
    slash: "plan-mode",
  },
  {
    id: "builtin.mode.goal",
    title: "Switch to Goal mode",
    category: "Session",
    keywords: ["mode", "goal", "objective", "autonomous", "outcome"],
    source: "builtin",
    slash: "goal-mode",
  },
  {
    id: "builtin.session.fork",
    title: "Fork this session",
    category: "Session",
    keywords: ["fork", "branch", "copy", "duplicate"],
    source: "builtin",
    slash: "fork",
    requiresProject: false,
  },
  {
    id: "builtin.session.import",
    title: "Import sessions…",
    category: "Session",
    keywords: ["import", "claude", "codex", "opencode", "pi", "migrate"],
    source: "builtin",
  },
  {
    id: "builtin.project.open",
    title: "Open project folder…",
    category: "Project",
    keywords: ["project", "open", "folder", "workspace", "directory"],
    source: "builtin",
    slash: "open",
  },
  {
    id: "builtin.settings.open",
    title: "Open settings",
    category: "App",
    keywords: ["settings", "preferences", "config"],
    source: "builtin",
    slash: "settings",
  },
  {
    id: "builtin.view.search",
    title: "Search sessions and settings",
    category: "Navigation",
    keywords: ["search", "find", "filter"],
    source: "builtin",
    slash: "search",
  },
  {
    id: "builtin.view.workpanel",
    title: "Toggle work panel",
    category: "Navigation",
    keywords: ["panel", "review", "files", "diff", "sidebar"],
    source: "builtin",
    slash: "panel",
  },
  {
    id: "builtin.view.sidebar",
    title: "Toggle sidebar",
    category: "Navigation",
    keywords: ["sidebar", "collapse", "expand"],
    source: "builtin",
    slash: "sidebar",
  },
  {
    id: "builtin.app.updates",
    title: "Check for updates",
    category: "App",
    keywords: ["update", "upgrade", "version", "release"],
    source: "builtin",
  },
];

/** Palette-shaped items (the `slash` field does not leak into the contract). */
export function builtinPaletteItems(): CommandItem[] {
  return BUILTIN_COMMANDS.map(({ slash: _slash, ...item }) => item);
}

/** Composer "/" entries for the builtin group. */
export function builtinComposerCommands(): ComposerCommand[] {
  return BUILTIN_COMMANDS.filter((c) => c.slash).map((def) => ({
    name: def.slash as string,
    kind: "builtin",
    title: def.title,
    ...(def.category ? { description: def.category } : {}),
    id: def.id,
  }));
}

/**
 * Subsequence scoring used by both the palette and the "/" and "@" menus.
 * Returns null when the query is not a subsequence of the target.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    // Reward adjacency and early matches, penalise distance.
    score += 10 + streak * 6 - Math.min(found - ti, 24);
    ti = found + 1;
  }
  // Prefer shorter targets when the match quality ties.
  return score - Math.floor(t.length / 8);
}

export interface CommandSearchQuery {
  query?: string;
  limit?: number;
  sessionId?: string;
}

/**
 * Rank the merged command namespace for a palette query. Title matches beat
 * keyword matches; a query with no letters (menu-open) returns the catalogue.
 */
export function searchCommands(commands: CommandItem[], query?: CommandSearchQuery): CommandItem[] {
  const text = (query?.query ?? "").trim();
  const limit = Math.min(Math.max(query?.limit ?? 50, 1), 200);
  if (!text) return commands.slice(0, limit);
  const scored: Array<{ item: CommandItem; score: number }> = [];
  for (const item of commands) {
    const titleScore = fuzzyScore(text, item.title);
    const slashScore = item.slash ? fuzzyScore(text, item.slash) : null;
    const keywordScore = item.keywords.reduce<number | null>((best, keyword) => {
      const s = fuzzyScore(text, keyword);
      if (s == null) return best;
      return best == null ? s - 12 : Math.max(best, s - 12);
    }, null);
    const idScore = fuzzyScore(text, item.id.replace(/^builtin\./, "").replace(/\./g, " "));
    const best = Math.max(
      titleScore ?? Number.NEGATIVE_INFINITY,
      (slashScore ?? Number.NEGATIVE_INFINITY) - 4,
      keywordScore ?? Number.NEGATIVE_INFINITY,
      (idScore ?? Number.NEGATIVE_INFINITY) - 20,
    );
    if (best > Number.NEGATIVE_INFINITY) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Merge builtin, plugin and skill commands into the composer namespace.
 * First registration wins on a slash-alias conflict, matching the reference's
 * deterministic conflict rule; the loser is reported to the caller.
 */
export function mergeComposerCommands(
  builtin: ComposerCommand[],
  contributions: Array<{ source: CommandSource; commands: ComposerCommand[] }>,
): { commands: ComposerCommand[]; conflicts: string[] } {
  const seen = new Set(builtin.map((c) => c.name));
  const commands = [...builtin];
  const conflicts: string[] = [];
  for (const group of contributions) {
    for (const command of group.commands) {
      if (seen.has(command.name)) {
        conflicts.push(`${command.name} (already provided by ${group.source})`);
        continue;
      }
      seen.add(command.name);
      commands.push(command);
    }
  }
  return { commands, conflicts };
}

/** The builtin slash command a composer draft starts with, if any. */
export function matchBuiltinSlash(name: string): CommandItem | null {
  const needle = name.trim().replace(/^\//, "").toLowerCase();
  if (!needle) return null;
  return BUILTIN_COMMANDS.find((c) => c.slash === needle) ?? null;
}
