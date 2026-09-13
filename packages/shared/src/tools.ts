import type { ToolDefinition } from "./models";

/**
 * The builtin tool catalog. Descriptions are part of the model-facing API:
 * they are sent to the provider verbatim, so keep them precise.
 *
 * Risk levels (ADR 0005):
 *   read  — executed without approval
 *   write — needs a grant or an interactive approval
 *   exec  — needs a grant or an interactive approval
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the current project. Paths are relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        max_chars: {
          type: "number",
          description: "Optional truncation limit in characters (default 100000).",
        },
      },
      required: ["path"],
    },
    risk: "read",
    source: "builtin",
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file inside the current project with the given content. Parent directories are created as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
    risk: "write",
    source: "builtin",
  },
  {
    name: "list_dir",
    description:
      "List the entries (files and directories) of a directory in the current project.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the project root (default: project root).",
        },
      },
    },
    risk: "read",
    source: "builtin",
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project directory. Returns combined stdout, stderr and the exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command line to run." },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in milliseconds (default 120000, max 600000).",
        },
      },
      required: ["command"],
    },
    risk: "exec",
    source: "builtin",
  },
];

export function builtinToolNames(): Set<string> {
  return new Set(BUILTIN_TOOLS.map((t) => t.name));
}

/** Tool call as stored in transcripts and sent to providers. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
