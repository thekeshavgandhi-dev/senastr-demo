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
    name: "ask_user",
    description:
      "Ask the user one or more questions and wait for their answers. Use this when you are blocked on a decision only the user can make (scope, approach, credentials, destructive actions). Keep questions short and offer options whenever possible.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 questions for the user.",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question text." },
              header: { type: "string", description: "Short label shown above the question." },
              options: {
                type: "array",
                description: "Suggested answers. Omit for free-text.",
                items: { type: "string" },
              },
              multiSelect: { type: "boolean", description: "Allow picking several options." },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    risk: "read",
    source: "builtin",
  },
  {
    name: "submit_plan",
    description:
      "Submit a step-by-step plan for the user's approval. Only available in plan mode: investigate with read-only tools first, then call this once with the full plan. The turn pauses until the user approves, rejects, or asks for revisions.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-paragraph summary of the proposed change." },
        steps: {
          type: "array",
          description: "Ordered implementation steps.",
          items: { type: "string" },
        },
        risks: { type: "string", description: "Risks, open questions, or things you will not touch." },
      },
      required: ["summary", "steps"],
    },
    risk: "read",
    source: "builtin",
  },
  {
    name: "Task",
    description:
      "Spawn a subagent to handle a self-contained piece of work in the background (exploration, research, drafting). Give a precise prompt with the files and context it needs; it returns a report. It cannot ask the user questions or spawn further subagents.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short (3-5 word) description of the delegated work." },
        prompt: {
          type: "string",
          description: "Full self-contained instructions for the subagent, including relevant file paths and what to report back.",
        },
        subagent: {
          type: "string",
          description: "Optional name of a configured subagent personality. Omit for the default agent.",
        },
      },
      required: ["description", "prompt"],
    },
    risk: "exec",
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
