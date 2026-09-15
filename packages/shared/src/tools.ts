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
      "The header carries a #TAG for the exact content you just read: pass it to edit_file or patch_file. " +
      "Optional start_line and end_line parameters let you inspect a specific slice of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        start_line: {
          type: "number",
          description: "Optional 1-based start line number to begin reading from.",
        },
        end_line: {
          type: "number",
          description: "Optional 1-based end line number (inclusive) to read up to.",
        },
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
    name: "patch_file",
    description:
      "Edit an existing file by searching for a block of text (`old_text`) and replacing it with `new_text`. " +
      "Tolerates whitespace and indentation differences. Returns a diff summary and new content tag. " +
      "Prefer this tool for surgical modifications to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        old_text: {
          type: "string",
          description: "The exact or near-match text block to find and replace.",
        },
        new_text: {
          type: "string",
          description: "The replacement text to insert (empty string to delete the matched text).",
        },
        expected_occurrences: {
          type: "number",
          description: "Optional expected number of occurrences (default 1). If more matches are found, the patch is rejected.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
    risk: "write",
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
    name: "code_intel",
    description:
      "Find symbol definitions, interfaces, types, classes, functions, and exports across project code. " +
      "Returns declarations with file paths, line numbers, and signatures. Use this for fast structural navigation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or pattern to locate (e.g. `AgentRuntime`, `createProvider`)." },
        path: {
          type: "string",
          description: "Optional subdirectory to restrict search under (relative to project root).",
        },
        kind: {
          type: "string",
          enum: ["all", "function", "class", "interface", "type", "variable", "export"],
          description: "Optional symbol kind filter (default `all`).",
        },
        max_results: {
          type: "number",
          description: "Optional cap on returned symbols (default 50, max 200).",
        },
      },
      required: ["query"],
    },
    risk: "read",
    source: "builtin",
  },
  {
    name: "web_fetch",
    description:
      "Fetch content from a web URL (HTTP/HTTPS) and return clean Markdown, text, or JSON. " +
      "Use this to consult online documentation, APIs, specs, or release notes.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
        max_chars: {
          type: "number",
          description: "Optional character limit for fetched content (default 50000, max 200000).",
        },
        format: {
          type: "string",
          enum: ["auto", "markdown", "text", "json"],
          description: "Output format preference (default `auto`).",
        },
      },
      required: ["url"],
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
      "line. Prefer patch_file for search-and-replace edits or edit_file for explicit line-range replacements.",
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
      "Spawn a specialist subagent to handle a self-contained piece of work in the background (e.g. `architect`, `explorer`, `coder`, `tester`, `debugger`, `reviewer`, `terminal`, `writer`). Give a precise prompt with the files and context it needs; it returns a report. It cannot ask the user questions or spawn further subagents.",
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
          description: "Name of a specialist subagent (`architect`, `explorer`, `coder`, `tester`, `debugger`, `reviewer`, `terminal`, `writer`, or custom). Omit for the default agent.",
        },
      },
      required: ["description", "prompt"],
    },
    risk: "exec",
    source: "builtin",
  },
  {
    name: "batch_tasks",
    description:
      "Spawn multiple specialist subagents in parallel to execute concurrent subtasks (e.g. concurrent exploration, multi-file investigation, or parallel sub-task generation). Returns a synthesized multi-agent report.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "List of subtasks to execute concurrently in parallel.",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Short description of the subtask." },
              prompt: { type: "string", description: "Detailed instructions for the subagent." },
              subagent: {
                type: "string",
                description: "Specialist subagent personality (`architect`, `explorer`, `coder`, `tester`, `debugger`, `reviewer`, `terminal`, `writer`, or custom).",
              },
            },
            required: ["description", "prompt"],
          },
        },
      },
      required: ["tasks"],
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
