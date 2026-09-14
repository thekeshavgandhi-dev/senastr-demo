import { app, shell } from "electron";
import type { UpdateState } from "@senastr/shared";

/**
 * In-app updates (parity: pi-desktop `updates/getState|check|download|install`).
 *
 * Two delivery lanes, deliberately:
 *
 *  1. `electron-updater` when the app is packaged and the module is installed.
 *     This is the real auto-update path the release workflow publishes for.
 *  2. A lightweight manifest check (`SENASTR_UPDATE_FEED` or the GitHub
 *     releases API for the configured repository) so development builds still
 *     show "a newer version exists" and can open the release page.
 *
 * The dynamic import keeps the app booting when electron-updater is absent
 * (it is an optional dependency: offline installs simply get lane 2).
 */

export interface UpdatesOptions {
  /** Repository slug used for the release check, e.g. "owner/name". */
  repository?: string;
  /** Explicit JSON feed URL; overrides the repository lookup. */
  feedUrl?: string;
}

interface UpdateManifest {
  version?: string;
  url?: string;
  notes?: string;
}

export class UpdatesService {
  private state: UpdateState;
  private updater: any = null;
  private listeners = new Set<(state: UpdateState) => void>();

  constructor(private readonly options: UpdatesOptions = {}) {
    this.state = {
      status: "idle",
      currentVersion: app.getVersion(),
      canSelfUpdate: false,
    };
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  private emit(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch, checkedAt: Date.now() };
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch {
        /* a bad listener must not break the update flow */
      }
    }
    return this.getState();
  }

  /** Attach electron-updater when the packaged build supports it. */
  private async loadUpdater(): Promise<any | null> {
    if (this.updater) return this.updater;
    try {
      const mod = await import("electron-updater");
      const autoUpdater = (mod as any).autoUpdater;
      if (!autoUpdater) return null;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("checking-for-update", () => this.emit({ status: "checking" }));
      autoUpdater.on("update-available", (info: any) =>
        this.emit({
          status: "available",
          availableVersion: String(info?.version ?? ""),
          releaseNotes: typeof info?.releaseNotes === "string" ? info.releaseNotes : undefined,
        }),
      );
      autoUpdater.on("update-not-available", () => this.emit({ status: "not-available" }));
      autoUpdater.on("download-progress", (progress: any) =>
        this.emit({ status: "downloading", progress: Math.round(Number(progress?.percent ?? 0)) }),
      );
      autoUpdater.on("update-downloaded", () => this.emit({ status: "downloaded", progress: 100 }));
      autoUpdater.on("error", (error: Error) => this.emit({ status: "error", error: error?.message ?? String(error) }));
      this.updater = autoUpdater;
      this.state.canSelfUpdate = app.isPackaged;
      return autoUpdater;
    } catch {
      return null;
    }
  }

  async check(): Promise<UpdateState> {
    this.emit({ status: "checking", error: undefined });
    const updater = app.isPackaged ? await this.loadUpdater() : null;
    if (updater) {
      try {
        await updater.checkForUpdates();
        return this.getState();
      } catch (error) {
        this.emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
        return this.getState();
      }
    }
    // Manifest lane (dev builds and installs without electron-updater).
    try {
      const manifest = await this.fetchManifest();
      if (!manifest?.version) {
        this.emit({
          status: "unsupported",
          error: "No update feed configured (set SENASTR_UPDATE_FEED or updates.repository).",
        });
        return this.getState();
      }
      const newer = compareVersions(manifest.version, this.state.currentVersion) > 0;
      this.emit({
        status: newer ? "available" : "not-available",
        availableVersion: manifest.version,
        releaseUrl: manifest.url,
        releaseNotes: manifest.notes,
        error: undefined,
      });
      return this.getState();
    } catch (error) {
      this.emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
      return this.getState();
    }
  }

  async download(): Promise<UpdateState> {
    const updater = this.updater ?? (await this.loadUpdater());
    if (!updater) {
      // Without a signed feed the honest answer is "open the release page".
      if (this.state.releaseUrl) void shell.openExternal(this.state.releaseUrl);
      return this.emit({
        status: this.state.status === "available" ? "available" : this.state.status,
        error: updater
          ? undefined
          : "This build cannot self-update; the release page has been opened instead.",
      });
    }
    try {
      this.emit({ status: "downloading", progress: 0 });
      await updater.downloadUpdate();
      return this.getState();
    } catch (error) {
      return this.emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  install(): UpdateState {
    if (this.updater && this.state.status === "downloaded") {
      try {
        this.updater.quitAndInstall();
        return this.getState();
      } catch (error) {
        return this.emit({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.state.releaseUrl) void shell.openExternal(this.state.releaseUrl);
    return this.getState();
  }

  openReleases(): void {
    const url = this.state.releaseUrl ?? "https://github.com";
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  }

  private async fetchManifest(): Promise<UpdateManifest | null> {
    const feed = this.options.feedUrl ?? process.env.SENASTR_UPDATE_FEED;
    if (feed) {
      const res = await fetch(feed, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`update feed returned HTTP ${res.status}`);
      return (await res.json()) as UpdateManifest;
    }
    const repository = this.options.repository ?? process.env.SENASTR_UPDATE_REPO;
    if (!repository) return null;
    const res = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "senastr-updater" },
    });
    if (!res.ok) throw new Error(`release lookup returned HTTP ${res.status}`);
    const release = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
    return {
      version: String(release.tag_name ?? "").replace(/^v/, ""),
      url: release.html_url,
      notes: release.body,
    };
  }
}

/** Numeric semver-ish comparison; returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/);
  const pb = b.replace(/^v/, "").split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const sa = pa[i] ?? "";
      const sb = pb[i] ?? "";
      if (sa !== sb) return sa > sb ? 1 : -1;
    }
  }
  return 0;
}
