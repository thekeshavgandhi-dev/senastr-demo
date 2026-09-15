import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@senastr/shared";
import { closestName, describeRepairs, levenshtein, repairToolCall } from "../src/tool-validation";

const readFile: ToolDefinition = {
  name: "read_file",
  description: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path" },
      start_line: { type: "number", description: "start" },
    },
    required: ["path"],
  },
  risk: "read",
  source: "builtin",
};

const editFile: ToolDefinition = {
  name: "edit_file",
  description: "edit",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path" },
      tag: { type: "string", description: "tag" },
      edits: {
        type: "array",
        description: "edits",
        items: {
          type: "object",
          properties: { start_line: { type: "number" }, end_line: { type: "number" }, new_text: { type: "string" } },
          required: ["start_line", "end_line", "new_text"],
        },
      },
    },
    required: ["path", "tag", "edits"],
  },
  risk: "write",
  source: "builtin",
};

const memory: ToolDefinition = {
  name: "memory",
  description: "memory",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write", "search", "list", "log", "forget"], description: "action" },
      key: { type: "string", description: "key" },
      mode: { type: "string", enum: ["replace", "append"], description: "mode" },
    },
    required: ["action"],
  },
  risk: "write",
  source: "builtin",
};

const tools = new Map<string, ToolDefinition>([
  [readFile.name, readFile],
  [editFile.name, editFile],
  [memory.name, memory],
]);
const names = [...tools.keys()];

describe("repairToolCall — happy paths", () => {
  it("passes a valid call through untouched", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: "a.ts" } }, readFile, names);
    expect(out.ok).toBe(true);
    expect(out.args).toEqual({ path: "a.ts" });
    expect(out.repairs).toEqual([]);
  });

  it("leaves unknown extra parameters alone but explains the likely typo", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: "a.ts", pth: "b.ts" } }, readFile, names);
    expect(out.ok).toBe(true);
    expect(out.args.path).toBe("a.ts");
    expect(out.repairs.join()).toMatch(/did you mean/);
  });
});

describe("repairToolCall — automatic repairs", () => {
  it("coerces a numeric string to a number", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: "a.ts", start_line: "12" } }, readFile, names);
    expect(out.ok).toBe(true);
    expect(out.args.start_line).toBe(12);
    expect(out.repairs.join()).toMatch(/number/);
  });

  it("rounds a float where an integer is expected", () => {
    const tool: ToolDefinition = {
      ...readFile,
      parameters: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" } }, required: ["path"] },
    };
    const out = repairToolCall({ name: "read_file", arguments: { path: "a.ts", start_line: 4.7 } }, tool, names);
    expect(out.args.start_line).toBe(4);
  });

  it("converts primitives to strings", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: 42 } }, readFile, names);
    expect(out.args.path).toBe("42");
  });

  it("wraps a single object where an array was expected", () => {
    const out = repairToolCall(
      { name: "edit_file", arguments: { path: "a.ts", tag: "abc", edits: { start_line: 1, end_line: 2, new_text: "x" } } },
      editFile,
      names,
    );
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.args.edits)).toBe(true);
    expect((out.args.edits as unknown[]).length).toBe(1);
  });

  it("parses an array or object delivered as a JSON string", () => {
    const asArray = repairToolCall(
      { name: "edit_file", arguments: { path: "a.ts", tag: "t", edits: '[{"start_line":1,"end_line":1,"new_text":"x"}]' } },
      editFile,
      names,
    );
    expect(Array.isArray(asArray.args.edits)).toBe(true);
    const asObject = repairToolCall({ name: "read_file", arguments: '{"path":"a.ts"}' as never }, readFile, names);
    expect(asObject.args.path).toBe("a.ts");
  });

  it("recovers arguments the provider could not parse (the _raw fallback)", () => {
    const out = repairToolCall(
      { name: "read_file", arguments: { _raw: '{"path": "src/app.ts", "start_line": 3}' } },
      readFile,
      names,
    );
    expect(out.ok).toBe(true);
    expect(out.args.path).toBe("src/app.ts");
    expect(out.args.start_line).toBe(3);
    expect(out.repairs.join()).toMatch(/recovered/);
  });

  it("recovers a JSON object embedded in prose", () => {
    const out = repairToolCall(
      { name: "read_file", arguments: { _raw: 'sure! here you go: {"path": "a.ts"} hope that helps' } },
      readFile,
      names,
    );
    expect(out.args.path).toBe("a.ts");
  });

  it("fixes parameter casing", () => {
    const out = repairToolCall({ name: "read_file", arguments: { Path: "a.ts" } }, readFile, names);
    expect(out.args.path).toBe("a.ts");
  });

  it("normalises enum case", () => {
    const out = repairToolCall({ name: "memory", arguments: { action: "SEARCH", key: "auth" } }, memory, names);
    expect(out.ok).toBe(true);
    expect(out.args.action).toBe("search");
  });

  it("coerces booleans delivered as strings", () => {
    const tool: ToolDefinition = {
      name: "flag_tool",
      description: "",
      parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
      risk: "read",
      source: "builtin",
    };
    expect(repairToolCall({ name: "flag_tool", arguments: { on: "true" } }, tool, ["flag_tool"]).args.on).toBe(true);
    expect(repairToolCall({ name: "flag_tool", arguments: { on: "false" } }, tool, ["flag_tool"]).args.on).toBe(false);
  });
});

describe("repairToolCall — refusals that teach", () => {
  it("refuses an unknown tool and suggests the nearest name", () => {
    const out = repairToolCall({ name: "read_fil", arguments: {} }, undefined, names);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown tool "read_fil"/);
    expect(out.error).toMatch(/Did you mean "read_file"/);
    expect(out.error).toMatch(/Available tools/);
  });

  it("names the missing required parameter and lists the schema", () => {
    const out = repairToolCall({ name: "read_file", arguments: {} }, readFile, names);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing required parameter: path/);
    expect(out.error).toMatch(/All parameters: path, start_line/);
  });

  it("treats an empty string as a missing parameter", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: "   " } }, readFile, names);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing required parameter: path/);
  });

  it("rejects a value outside the enum and lists the allowed values", () => {
    const out = repairToolCall({ name: "memory", arguments: { action: "delete" } }, memory, names);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/expected one of read \| write \| search \| list \| log \| forget/);
  });

  it("rejects a wrong type it cannot safely coerce", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: "a.ts", start_line: { deep: true } } }, readFile, names);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/expected a number but received an object/);
  });

  it("rejects a boolean where a number is required", () => {
    const out = repairToolCall({ name: "read_file", arguments: { path: "a.ts", start_line: true } }, readFile, names);
    expect(out.ok).toBe(false);
  });

  it("validates required fields inside array items", () => {
    const out = repairToolCall(
      { name: "edit_file", arguments: { path: "a.ts", tag: "t", edits: [{ start_line: 1, end_line: 1 }] } },
      editFile,
      names,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing "new_text"/);
    expect(out.error).toMatch(/Every item needs/);
  });

  it("explains unrecoverable arguments instead of guessing", () => {
    const out = repairToolCall({ name: "read_file", arguments: { _raw: "not json at all {" } }, readFile, names);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing required parameter: path/);
  });
});

describe("describeRepairs", () => {
  it("renders nothing when there is nothing to report", () => {
    expect(describeRepairs([])).toBe("");
  });
  it("renders a readable note", () => {
    expect(describeRepairs(["converted \"x\" to a number"])).toContain("auto-corrected");
  });
});

describe("levenshtein / closestName", () => {
  it("measures edit distance", () => {
    expect(levenshtein("read_file", "read_file")).toBe(0);
    expect(levenshtein("read_file", "read_fil")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
  it("picks the nearest tool name", () => {
    expect(closestName("write_fil", names)).toBe("edit_file");
    expect(closestName("zzzzzzzzzzzzzzzz", names)).toBeUndefined();
  });
});
