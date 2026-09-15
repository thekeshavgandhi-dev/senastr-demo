import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  builtinToolNames,
  ErrorCodes,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  RpcError,
} from "./index";

describe("tool catalog", () => {
  it("has unique, well-formed builtin tools", () => {
    const names = new Set<string>();
    for (const tool of BUILTIN_TOOLS) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
      expect(["read", "write", "exec"]).toContain(tool.risk);
      expect(tool.source).toBe("builtin");
    }
  });

  it("exposes the expected builtin set", () => {
    expect([...builtinToolNames()].sort()).toEqual([
      "Task",
      "ask_user",
      "batch_tasks",
      "code_intel",
      "edit_file",
      "glob",
      "grep",
      "list_dir",
      "memory",
      "patch_file",
      "read_file",
      "run_command",
      "submit_plan",
      "think",
      "todo_write",
      "use_skill",
      "verify",
      "web_fetch",
      "write_file",
    ]);
  });

  it("keeps tool descriptions tight enough for the model to hold in context", () => {
    // Descriptions are shipped verbatim on every request; a runaway catalog
    // silently eats the budget the task itself needs.
    const total = BUILTIN_TOOLS.reduce((sum, t) => sum + t.description.length, 0);
    expect(total).toBeLessThan(9_000);
  });

  it("gives every tool a typed parameter object with a description", () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.parameters.type).toBe("object");
      const props = tool.parameters.properties as Record<string, { description?: string }>;
      for (const [name, schema] of Object.entries(props)) {
        expect(typeof name).toBe("string");
        expect(schema.description?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("protocol constants", () => {
  it("method names are unique", () => {
    const values = Object.values(Methods);
    expect(new Set(values).size).toBe(values.length);
  });

  it("notification names are unique and distinct from methods", () => {
    const methods = new Set<string>(Object.values(Methods));
    for (const n of Object.values(Notifications)) {
      expect(methods.has(n)).toBe(false);
    }
  });

  it("RpcError carries a numeric code", () => {
    const err = new RpcError(ErrorCodes.PATH_ESCAPES_PROJECT, "escaped");
    expect(err.code).toBe(ErrorCodes.PATH_ESCAPES_PROJECT);
    expect(err).toBeInstanceOf(Error);
  });

  it("protocol version is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
