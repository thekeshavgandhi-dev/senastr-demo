import { useEffect } from "react";
import { useSenastr } from "./hooks/useSenastr";
import { resolveTheme } from "./lib/prefs";
import { AskDialog } from "./components/AskDialog";
import { PlanDialog } from "./components/PlanDialog";
import { Sidebar } from "./components/Sidebar";
import { ConversationTopbar } from "./components/ConversationTopbar";
import { ChatSurface } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { PermissionDialog } from "./components/PermissionDialog";
import { SearchDialog } from "./components/SearchDialog";
import { ToastHost } from "./components/Toast";
import { WorkPanel } from "./components/workpanel/WorkPanel";
import { hasBridge } from "./lib/api";

export default function App() {
  // Without the preload bridge there is no backend: render an explicit
  // "not connected" screen instead of a UI whose every control would fail.
  if (!hasBridge()) return <BridgeMissing />;
  return <AppShell />;
}

function BridgeMissing() {
  return (
    <div className="app bridge-missing" role="alert">
      <div className="bridge-missing-card">
        <div className="brand-mark">s</div>
        <h1>senastr backend is not connected</h1>
        <p>
          This window was loaded without the desktop host, so every action (sending prompts,
          opening projects, settings — all of it) has nothing to talk to.
        </p>
        <ul>
          <li>Run the desktop app with <code>pnpm dev</code> (Electron loads the preload bridge and starts the host-core sidecar).</li>
          <li>If the window is part of the packaged app, reinstall or repair it — the bridge script is missing.</li>
        </ul>
      </div>
    </div>
  );
}

function AppShell() {
  const s = useSenastr();

  // Apply theme + font scale to the document root.
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(s.theme);
    };
    apply();
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const onChange = () => s.theme === "system" && apply();
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, [s.theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(s.fontScale));
  }, [s.fontScale]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setSearchOpen(!s.searchOpen);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        s.setSidebarCollapsed(!s.sidebarCollapsed);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.setWorkPanelOpen(!s.workPanelOpen);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        s.setView(s.view === "settings" ? "chat" : "settings");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (s.view === "chat") void s.newSession(s.activeSession?.projectPath ?? undefined);
      } else if (e.key === "Escape" && s.searchOpen) {
        s.setSearchOpen(false);
      } else if (typing) {
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  // The `s` object identity changes every render; the keydown effect above
  // re-subscribes — fine for a single global listener.

  const activeAsk = s.pendingAsks.find((r) => r.sessionId === s.activeSession?.id) ?? s.pendingAsks[0] ?? null;

  if (s.view === "settings") {
    return (
      <div className="app settings-mode">
        <SettingsView store={s} />
        <SearchDialog store={s} />
        <ToastHost notices={s.notices} onDismiss={s.dismissNotice} />
        {s.pendingPermission && (
          <PermissionDialog
            request={s.pendingPermission}
            sessionTitle={s.activeSession?.title}
            queueDepth={s.pendingPermissionCount}
            onDecide={(allow, remember) => s.respondPermission(allow, remember)}
          />
        )}
        {activeAsk && (
          <AskDialog
            request={activeAsk}
            sessionTitle={s.sessions.find((x) => x.id === activeAsk.sessionId)?.title}
            onSubmit={(requestId, answers) => void s.resolveAsk(requestId, answers)}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`app ${s.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {!s.sidebarCollapsed && <Sidebar store={s} />}
      <main className="main-pane">
        <ConversationTopbar store={s} />
        <ChatSurface store={s} />
      </main>
      {s.workPanelOpen && <WorkPanel store={s} />}
      <SearchDialog store={s} />
      <ToastHost notices={s.notices} onDismiss={s.dismissNotice} />
      {s.pendingPermission && (
        <PermissionDialog
          request={s.pendingPermission}
          sessionTitle={s.activeSession?.title}
          queueDepth={s.pendingPermissionCount}
          onDecide={(allow, remember) => s.respondPermission(allow, remember)}
        />
      )}
      {activeAsk && (
        <AskDialog
          request={activeAsk}
          sessionTitle={s.activeSession?.title}
          onSubmit={(requestId, answers) => void s.resolveAsk(requestId, answers)}
        />
      )}
      {s.planProposal && (
        <PlanDialog
          proposal={s.planProposal}
          sessionTitle={s.sessions.find((x) => x.id === s.planProposal?.sessionId)?.title}
          busy={s.busy}
          onApprove={() => void s.approvePlan()}
          onReject={(feedback) => void s.rejectPlan(feedback)}
          onDismiss={() => s.dismissPlan()}
        />
      )}
    </div>
  );
}
