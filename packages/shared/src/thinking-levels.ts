/**
 * Reasoning / thinking levels (parity: pi-desktop `shared/thinking-levels.ts`).
 *
 * A model may publish the ladder of levels it supports; the user (or the
 * stored default) picks one. Everything here is pure so both the renderer and
 * the agent runtime clamp the same way.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Strongest level enabled on a ladder (`off` when the ladder is empty). */
export function highestSupportedThinkingLevel(
  levels: readonly ThinkingLevel[] | undefined,
): ThinkingLevel {
  const supported = new Set(levels ?? []);
  for (let index = THINKING_LEVELS.length - 1; index >= 0; index -= 1) {
    const level = THINKING_LEVELS[index];
    if (supported.has(level)) return level;
  }
  return "off";
}

/**
 * Clamp a requested level onto an enabled ladder with the canonical
 * nearest-supported rule: walk up first, then down, then `off`.
 */
export function nearestSupportedThinkingLevel(
  requested: ThinkingLevel,
  levels: readonly ThinkingLevel[] | undefined,
): ThinkingLevel {
  const supported = new Set(levels ?? []);
  if (supported.size === 0) return "off";
  if (supported.has(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  return "off";
}

export interface ThinkingLevelBindingSource {
  thinkingLevels?: readonly ThinkingLevel[] | null;
  defaultThinkingLevel?: ThinkingLevel | null;
}

/**
 * The level a new draft or session starts at for a model binding. Prefer the
 * stored default when it is still enabled; otherwise clamp it. With no stored
 * default, fall back to the strongest enabled level so a reasoning model never
 * starts at `off` merely because Settings has not picked a default yet.
 */
export function initialThinkingLevelForBinding(
  binding: ThinkingLevelBindingSource | null | undefined,
  fallbackLevels?: readonly ThinkingLevel[],
): ThinkingLevel {
  const enabled = binding?.thinkingLevels ?? fallbackLevels;
  const stored = binding?.defaultThinkingLevel;
  if (stored != null) return nearestSupportedThinkingLevel(stored, enabled);
  return highestSupportedThinkingLevel(enabled);
}

export interface PublishedThinkingSource {
  reasoning?: boolean;
  supportedThinkingLevels?: readonly ThinkingLevel[];
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * Levels a model actually publishes, in canonical order. A model that does not
 * publish reasoning support yields an empty list (never a token `off`).
 */
export function publishedThinkingLevels(
  model?: PublishedThinkingSource | null,
): ThinkingLevel[] {
  if (!model) return [];
  if (model.reasoning === false) return [];
  const published = new Set<ThinkingLevel>(model.supportedThinkingLevels ?? []);
  if (published.size === 0 && model.thinkingLevelMap) {
    for (const [level, value] of Object.entries(model.thinkingLevelMap)) {
      if (value !== null && value !== undefined) published.add(level as ThinkingLevel);
    }
  }
  if (published.size === 0) {
    return model.reasoning === true ? ["low", "medium", "high"] : [];
  }
  return THINKING_LEVELS.filter((level) => published.has(level));
}

/**
 * OpenAI-style `reasoning_effort` for a level. `off` means "omit the field",
 * which is how both OpenAI and compatible gateways disable reasoning.
 */
export function reasoningEffortFor(level: ThinkingLevel): string | null {
  switch (level) {
    case "off":
      return null;
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return null;
  }
}

/** Anthropic extended-thinking token budget for a level (null = disabled). */
export function anthropicThinkingBudgetFor(
  level: ThinkingLevel,
  maxTokens: number,
): number | null {
  if (level === "off") return null;
  const share: Record<Exclude<ThinkingLevel, "off">, number> = {
    minimal: 0.05,
    low: 0.12,
    medium: 0.25,
    high: 0.5,
    xhigh: 0.75,
  };
  const ratio = share[level] ?? 0.25;
  // Anthropic requires the budget to stay below max_tokens and be >= 1024.
  const budget = Math.floor(maxTokens * ratio);
  return Math.max(1024, Math.min(budget, Math.max(1024, maxTokens - 1024)));
}

/** Gemini `thinkingConfig.thinkingBudget` for a level (null = disabled). */
export function googleThinkingBudgetFor(level: ThinkingLevel): number | null {
  switch (level) {
    case "off":
      return 0;
    case "minimal":
      return 512;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
      return 32768;
    default:
      return null;
  }
}
