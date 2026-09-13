import { useSenastr } from "./hooks/useSenastr";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { PermissionDialog } from "./components/PermissionDialog";

export default function App() {
  const s = useSenastr();

  return (
    <div className="app">
      <Sidebar
        sessions={s.sessions}
        activeId={s.activeSession?.id ?? null}
        busy={s.busy}
        version={s.version}
        onNewSession={() => void s.newSession()}
        onOpenProject={() => void s.openProject()}
        onSelect={(id) => s.selectSession(id)}
        onDelete={(id) => void s.deleteSession(id)}
        onSettings={() => s.setView("settings")}
        onChat={() => s.setView("chat")}
        view={s.view}
      />
      <main className="main">
        {s.view === "settings" ? (
          <SettingsView store={s} />
        ) : (
          <ChatView store={s} />
        )}
      </main>

      {s.pendingPermission && (
        <PermissionDialog
          request={s.pendingPermission}
          onDecide={(allow, remember) => s.respondPermission(allow, remember)}
        />
      )}

      {s.notices.length > 0 && (
        <div className="notices">
          {s.notices.map((n) => (
            <div key={n.id} className={`notice ${n.kind}`}>
              {n.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
