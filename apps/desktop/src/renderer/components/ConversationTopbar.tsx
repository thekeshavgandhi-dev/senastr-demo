import type { SenastrStore } from "../hooks/useSenastr";
import { isDefaultTitle, projectDisplayName } from "../lib/prefs";
import { NotificationBell } from "./NotificationCenter";
import { IconNewSession, IconPanel, IconSearch, IconSidebar, IconSparkles } from "./icons";
import { TooltipButton } from "./ui";

export function ConversationTopbar({ store }: { store: SenastrStore }) {
  const { activeSession, projectMeta } = store;
  const title = isDefaultTitle(activeSession?.title) ? "Untitled task" : (activeSession?.title ?? "senastr");
  const project = activeSession?.projectPath
    ? projectDisplayName(activeSession.projectPath, projectMeta[activeSession.projectPath])
    : null;

  return (
    <div className="ct" role="toolbar" aria-label="Conversation">
      <div className="ct-left">
        {store.sidebarCollapsed && (
          <TooltipButton
            type="button"
            className="ct-btn"
            tooltip="Expand sidebar (Ctrl+B)"
            onClick={() => store.setSidebarCollapsed(false)}
          >
            <IconSidebar size={15} />
          </TooltipButton>
        )}
        <div className="ct-title" title={project ? `${project} · ${title}` : title}>
          {project ? (
            <>
              <span className="ct-project">{project}</span>
              <span className="ct-sep">/</span>
            </>
          ) : null}
          <span className="ct-task">{title}</span>
        </div>
      </div>
      <div className="ct-right">
        <TooltipButton
          type="button"
          className="ct-btn"
          tooltip="New task (Ctrl+Shift+O)"
          onClick={() => void store.newSession(store.activeSession?.projectPath ?? undefined)}
        >
          <IconNewSession size={15} />
        </TooltipButton>
        <TooltipButton
          type="button"
          className="ct-btn"
          tooltip="Search (Ctrl+K)"
          onClick={() => store.setSearchOpen(true)}
        >
          <IconSearch size={15} />
        </TooltipButton>
        {store.activeSession && (store.activeSession.messages?.length ?? 0) > 0 ? (
          <TooltipButton
            type="button"
            className="ct-btn"
            tooltip="Generate title with AI"
            onClick={() => void store.suggestTitle()}
          >
            <IconSparkles size={15} />
          </TooltipButton>
        ) : null}
        <NotificationBell store={store} />
        <TooltipButton
          type="button"
          className={`ct-btn ${store.workPanelOpen ? "active" : ""}`}
          tooltip="Toggle work panel (Ctrl+J)"
          aria-pressed={store.workPanelOpen}
          onClick={() => store.setWorkPanelOpen(!store.workPanelOpen)}
        >
          <IconPanel size={15} />
        </TooltipButton>
      </div>
    </div>
  );
}
