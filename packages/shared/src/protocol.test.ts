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
      "list_dir",
      "read_file",
      "run_command",
      "write_file",
    ]);
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
