import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tiny JSON document store with atomic writes (tmp file + rename).
 *
 * ADR 0004: v0 persists state as plain JSON files owned by the host-core
 * process. The store is deliberately the single write path so a future
 * SQLite/LSM backend can replace it without touching callers.
 */
export class JsonFileStore<T> {
  private value: T;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private initial: T,
  ) {
    this.value = this.readExisting();
  }

  private readExisting(): T {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as T;
    } catch {
      return this.initial;
    }
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    this.schedulePersist();
  }

  update(fn: (current: T) => T): T {
    const next = fn(this.value);
    this.set(next);
    return next;
  }

  private schedulePersist(): void {
    this.queue = this.queue
      .then(async () => {
        const dir = dirname(this.filePath);
        mkdirSync(dir, { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.value, null, 2), "utf8");
        renameSync(tmp, this.filePath);
      })
      .catch((err: unknown) => {
        process.stderr.write(`[senastr/host-core] persist failed for ${this.filePath}: ${String(err)}\n`);
      });
  }

  /** Wait for all queued writes to hit disk. Used on shutdown and in tests. */
  async flush(): Promise<void> {
    await this.queue;
  }
}
