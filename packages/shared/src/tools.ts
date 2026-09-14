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
      "Read a UTF-8 text file from the current project. Paths are relative to the project root. " +
      "The header carries a #TAG for the exact content you just read: pass it to edit_file so an " +
      "edit can be verified against the version you saw.",
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
    name: "glob",
    description:
      "Find files in the current project by glob pattern (for example `src/**/*.ts`, `**/*.md`, " +
      "`packages/*/package.json`). Returns project-relative paths, newest directories skipped " +
      "(node_modules, .git, dist, build, out, target, coverage). Use this instead of listing " +
      "directories one by one.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern with `*`, `**` and `?` wildcards." },
        path: {
          type: "string",
          description: "Optional directory to search under (relative to the project root).",
        },
        max_results: {
          type: "number",
          description: "Optional cap on returned paths (default 500, max 2000).",
        },
      },
      required: ["pattern"],
    },
    risk: "read",
    source: "builtin",
  },
  {
    name: "grep",
    description:
      "Search file contents in the current project with a regular expression and return " +
      "`path:line: text` matches. Use it to locate symbols, usages or configuration without " +
      "reading whole files. Combine with `include` (a glob such as `**/*.ts`) to narrow the search.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression to search for." },
        path: {
          type: "string",
          description: "Optional file or directory to search (relative to the project root).",
        },
        include: { type: "string", description: "Optional glob filter for candidate files." },
        max_results: {
          type: "number",
          description: "Optional cap on returned matches (default 200, max 1000).",
        },
      },
      required: ["pattern"],
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
    name: "edit_file",
    description:
      "Edit an existing file by replacing whole line ranges, verified against a #TAG. The tag comes " +
      "from read_file (or the previous edit_file/write_file result) and must match the file's current " +
      "content — if the file changed since you read it, the edit is rejected so nothing is clobbered. " +
      "Line numbers are 1-based and inclusive; use `end_line` = `start_line` - 1 to insert before a " +
      "line. Prefer this over write_file for changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        tag: {
          type: "string",
          description: "The 8-character content tag from read_file (the `#TAG` in the header).",
        },
        edits: {
          type: "array",
          description: "Line-range replacements, applied from the bottom of the file upwards.",
          items: {
            type: "object",
            properties: {
              start_line: { type: "number", description: "First line to replace (1-based)." },
              end_line: {
                type: "number",
                description: "Last line to replace (inclusive). start_line - 1 inserts before start_line.",
              },
              new_text: { type: "string", description: "Replacement text (may be empty to delete)." },
            },
            required: ["start_line", "end_line", "new_text"],
          },
        },
      },
      required: ["path", "tag", "edits"],
    },
    risk: "write",
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
