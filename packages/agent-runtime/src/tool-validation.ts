import type { ToolDefinition } from "@senastr/shared";

/**
 * Tool-call repair and validation.
 *
 * Models mis-shape tool calls constantly: a number arrives as `"5"`, an array
 * as one bare object, arguments as a JSON string, a name with a typo. Left
 * alone each one costs a full round-trip and often sends the model into a
 * retry spiral that never recovers.
 *
 * This module fixes what can be fixed deterministically and refuses what
 * cannot — always with a message the model can act on. The agent loop feeds
 * that message straight back as the tool result, so a bad call becomes one
 * cheap correction instead of a derailed turn.
 *
 * Rules of the road:
 *  - never invent a value the model did not supply (except safe type casts);
 *  - every automatic fix is reported back, so the model learns;
 *  - a refusal names the parameter, the expected shape, and the fix.
 */

export interface ToolCallRepair {
  ok: boolean;
  /** Repaired arguments to execute. */
  args: Record<string, unknown>;
  /** Human-readable list of automatic fixes applied. */
  repairs: string[];
  /** Present (and `ok === false`) when the call cannot be executed. */
  error?: string;
}

/** Placeholder used by the providers when tool arguments fail to parse. */
const RAW_ARGS_KEY = "_raw";

const MAX_SUGGESTIONS = 6;
const MAX_NAME_DISTANCE = 4;

export function levenshtein(a: string, b: string, cap = MAX_NAME_DISTANCE): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return rowMin;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function closestName(name: string, candidates: string[]): string | undefined {
  const target = name.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const value = candidate.toLowerCase();
    const score = levenshtein(target, value);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= MAX_NAME_DISTANCE ? best : undefined;
}

/**
 * Validate (and where possible repair) one tool call against its schema.
 */
export function repairToolCall(
  call: { name: string; arguments?: Record<string, unknown> | null },
  tool: ToolDefinition | undefined,
  knownNames: string[],
): ToolCallRepair {
  const repairs: string[] = [];
  let args = normalizeArgs(call.arguments, repairs);

  if (!tool) {
    const suggestion = nearestToolName(call.name, knownNames);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
    return {
      ok: false,
      args,
      repairs,
      error:
        `unknown tool "${call.name}".${hint} Available tools: ${knownNames.slice(0, MAX_SUGGESTIONS * 3).join(", ")}` +
        (knownNames.length > MAX_SUGGESTIONS * 3 ? ` (+${knownNames.length - MAX_SUGGESTIONS * 3} more)` : "") +
        ". Call one of them by its exact name.",
    };
  }

  const schema = (tool.parameters ?? { type: "object", properties: {} }) as {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  // Case-insensitive key recovery: `Path` vs `path`.
  args = recoverKeys(args, properties, repairs);

  const missing = required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || (typeof value === "string" && !value.trim());
  });
  if (missing.length) {
    const described = missing.map((key) => `${key} (${describeType(properties[key])})`).join(", ");
    return {
      ok: false,
      args,
      repairs,
      error: `"${tool.name}" is missing required parameter${missing.length > 1 ? "s" : ""}: ${described}. ${
        Object.keys(properties).length
          ? `All parameters: ${Object.keys(properties).join(", ")}.`
          : ""
      } Re-issue the call with ${missing.length > 1 ? "them" : "it"} set.`,
    };
  }

  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop) {
      // Unknown keys are harmless — the tool ignores them — but a typo is a
      // common cause of a silently ignored parameter, so say something.
      const near = Object.keys(properties).length
        ? closestName(key, Object.keys(properties))
        : undefined;
      if (near) {
        repairs.push(`ignored unknown parameter "${key}" (did you mean "${near}"?)`);
        continue;
      }
      coerced[key] = value;
      continue;
    }
    const outcome = coerceValue(value, prop, key);
    if (!outcome.ok) {
      return {
        ok: false,
        args,
        repairs,
        error: `"${tool.name}" parameter "${key}": ${outcome.error}. Re-issue the call with a valid value.`,
      };
    }
    if (outcome.repair) repairs.push(outcome.repair);
    coerced[key] = outcome.value;
  }

  // A parameter the schema requires but the model omitted from a *sibling*
  // object (e.g. edit_file edits missing `new_text`) is caught here too.
  const nested = validateNestedObjects(coerced, properties);
  if (nested.error) return { ok: false, args: coerced, repairs, error: nested.error };
  if (nested.repair) repairs.push(nested.repair);

  return { ok: true, args: coerced, repairs };
}

function nearestToolName(name: string, known: string[]): string | undefined {
  if (!known.length) return undefined;
  const lower = name.toLowerCase();
  const exact = known.find((n) => n.toLowerCase() === lower);
  if (exact && exact !== name) return exact;
  return closestName(name, known);
}

function normalizeArgs(
  raw: Record<string, unknown> | null | undefined,
  repairs: string[],
): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === "string") {
    const parsed = tryParseJsonObject(raw);
    if (parsed) {
      repairs.push("parsed `arguments` from a JSON string");
      return parsed;
    }
  }
  return {};
}

/**
 * The providers stash unparseable argument text under `_raw`. Recover it when
 * it is salvagable, otherwise leave it for the required-parameter check to
 * reject with a precise message.
 */
function recoverRawArgs(args: Record<string, unknown>, repairs: string[]): Record<string, unknown> {
  const raw = args[RAW_ARGS_KEY];
  if (typeof raw !== "string") return args;
  const parsed = tryParseJsonObject(raw);
  if (parsed) {
    repairs.push("recovered malformed tool arguments (re-parsed the JSON payload)");
    return parsed;
  }
  return args;
}

export function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function recoverKeys(
  args: Record<string, unknown>,
  properties: Record<string, any>,
  repairs: string[],
): Record<string, unknown> {
  const out = recoverRawArgs(args, repairs);
  const keys = Object.keys(properties);
  if (!keys.length) return out;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (key in properties) {
      result[key] = value;
      continue;
    }
    const match = keys.find((k) => k.toLowerCase() === key.toLowerCase());
    if (match) {
      repairs.push(`mapped parameter "${key}" to "${match}"`);
      result[match] = value;
      continue;
    }
    result[key] = value;
  }
  return result;
}

interface CoerceResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  repair?: string;
}

function coerceValue(value: unknown, schema: any, key: string): CoerceResult {
  const expected = typeof schema?.type === "string" ? schema.type : undefined;

  if (schema?.enum && Array.isArray(schema.enum)) {
    const allowed: string[] = schema.enum.map((v: unknown) => String(v));
    const asString = String(value).trim().toLowerCase();
    const hit = allowed.find((v) => v.toLowerCase() === asString);
    if (hit !== undefined) {
      return { ok: true, value: hit, repair: hit !== value ? `normalized "${key}" to "${hit}"` : undefined };
    }
    return {
      ok: false,
      error: `expected one of ${allowed.join(" | ")} but received ${JSON.stringify(value)?.slice(0, 80)}`,
    };
  }

  if (!expected) return { ok: true, value };

  switch (expected) {
    case "string":
      if (typeof value === "string") return { ok: true, value };
      if (typeof value === "number" || typeof value === "boolean") {
        return { ok: true, value: String(value), repair: `converted "${key}" to a string` };
      }
      if (value && typeof value === "object") {
        return { ok: true, value: JSON.stringify(value), repair: `serialised "${key}" to a JSON string` };
      }
      return { ok: false, error: `expected a string but received ${typeName(value)}` };

    case "number":
    case "integer": {
      if (typeof value === "number" && Number.isFinite(value)) {
        return expected === "integer" && !Number.isInteger(value)
          ? { ok: true, value: Math.trunc(value), repair: `rounded "${key}" to an integer` }
          : { ok: true, value };
      }
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return { ok: true, value: Number(value), repair: `converted "${key}" from a string to a number` };
      }
      if (typeof value === "boolean") return { ok: false, error: "expected a number but received a boolean" };
      return { ok: false, error: `expected a number but received ${typeName(value)}` };
    }

    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true" || value === 1 || value === "1") return { ok: true, value: true, repair: `converted "${key}" to a boolean` };
      if (value === "false" || value === 0 || value === "0") return { ok: true, value: false, repair: `converted "${key}" to a boolean` };
      return { ok: false, error: `expected a boolean but received ${typeName(value)}` };

    case "array": {
      if (Array.isArray(value)) return { ok: true, value };
      if (typeof value === "string") {
        const parsed = tryParseJson<any>(value);
        if (Array.isArray(parsed)) return { ok: true, value: parsed, repair: `parsed "${key}" from a JSON string` };
      }
      // A single object where an array was expected is the classic mistake
      // (`edits: {…}`); wrapping it is unambiguous and saves the round-trip.
      if (value && typeof value === "object") {
        return { ok: true, value: [value], repair: `wrapped "${key}" in an array` };
      }
      return { ok: false, error: `expected an array but received ${typeName(value)}` };
    }

    case "object": {
      if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
      if (typeof value === "string") {
        const parsed = tryParseJson<any>(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { ok: true, value: parsed, repair: `parsed "${key}" from a JSON string` };
        }
      }
      return { ok: false, error: `expected an object but received ${typeName(value)}` };
    }

    default:
      return { ok: true, value };
  }
}

function validateNestedObjects(
  args: Record<string, unknown>,
  properties: Record<string, any>,
): { error?: string; repair?: string } {
  for (const [key, schema] of Object.entries(properties)) {
    if (schema?.type !== "array" || !schema.items || schema.items.type !== "object") continue;
    const value = args[key];
    if (!Array.isArray(value)) continue;
    const requiredInItem: string[] = Array.isArray(schema.items.required) ? schema.items.required : [];
    if (!requiredInItem.length) continue;
    for (const [index, item] of value.entries()) {
      if (!item || typeof item !== "object") continue;
      const missing = requiredInItem.filter((field) => (item as Record<string, unknown>)[field] === undefined);
      if (missing.length) {
        return {
          error: `"${key}[${index}]" is missing ${missing.map((m) => `"${m}"`).join(", ")}. Every item needs: ${requiredInItem.join(", ")}.`,
        };
      }
    }
  }
  return {};
}

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

function describeType(schema: any): string {
  if (!schema) return "any";
  if (schema.enum) return `one of ${schema.enum.join(" | ")}`;
  if (schema.type === "array") return "array";
  if (schema.type === "object") return "object";
  return schema.type ?? "any";
}

/** Render the repair notes the way the model should see them. */
export function describeRepairs(repairs: string[]): string {
  if (!repairs.length) return "";
  return `\n\n(auto-corrected: ${repairs.join("; ")})`;
}
