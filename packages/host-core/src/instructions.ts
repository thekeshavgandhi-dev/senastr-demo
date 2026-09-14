import { join, resolve } from "node:path";
import { ErrorCodes, RpcError, type ProjectContext } from "@senastr/shared";
import { JsonFileStore } from "./store";

const MAX_CHARS = 64_000;
const GLOBAL_KEY = "";

/**
 * Standing instructions + memory, global and per project. The runtime
 * injects both layers into the system prompt; the UI edits them via the
 * Instructions settings tab (global) and the per-project dialog.
 */
export class InstructionService {
  private readonly store: JsonFileStore<Record<string, ProjectContext>>;

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  constructor(dataDir: string) {
    this.store = new JsonFileStore<Record<string, ProjectContext>>(join(dataDir, "instructions.json"), {});
  }

  get(projectPath: string | null): ProjectContext {
    const key = normalizeKey(projectPath);
    const existing = this.store.get()[key];
    if (existing) return { ...existing };
    return { projectPath: projectPath ? resolve(projectPath) : null, instructions: "", memory: "", updatedAt: 0 };
  }

  set(projectPath: string | null, instructions: string, memory: string): ProjectContext {
    const cleanInstructions = typeof instructions === "string" ? instructions : "";
    const cleanMemory = typeof memory === "string" ? memory : "";
    if (cleanInstructions.length > MAX_CHARS || cleanMemory.length > MAX_CHARS) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `instructions exceed ${MAX_CHARS} characters per field`);
    }
    const key = normalizeKey(projectPath);
    const record: ProjectContext = {
      projectPath: projectPath ? resolve(projectPath) : null,
      instructions: cleanInstructions,
      memory: cleanMemory,
      updatedAt: Date.now(),
    };
    this.store.update((all) => ({ ...all, [key]: record }));
    return { ...record };
  }
}

function normalizeKey(projectPath: string | null): string {
  return projectPath && projectPath.trim() ? resolve(projectPath) : GLOBAL_KEY;
}
