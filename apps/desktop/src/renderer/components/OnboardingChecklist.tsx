import type { SenastrStore } from "../hooks/useSenastr";
import { IconCheck, IconChevronRight } from "./icons";

export function OnboardingChecklist({ store }: { store: SenastrStore }) {
  const hasProject = Boolean(store.activeSession?.projectPath);
  const hasProvider = store.providers.some((p) => p.enabled && p.models.length > 0);
  const hasMessages = (store.activeSession?.messages.length ?? 0) > 0;

  const steps = [
    {
      done: hasProject,
      label: "Open a project folder",
      hint: "The agent works inside one local project",
      action: () => void store.openProject(),
      cta: "Open…",
    },
    {
      done: hasProvider,
      label: "Connect a model provider",
      hint: "Bring your own OpenAI / Anthropic / Gemini key",
      action: () => store.setView("settings"),
      cta: "Settings",
    },
    {
      done: hasMessages,
      label: "Send your first task",
      hint: "Ask anything about the project below",
      action: undefined,
      cta: undefined,
    },
  ];

  if (steps.every((s) => s.done)) return null;

  return (
    <div className="onboarding">
      {steps.map((s, i) => (
        <button
          key={i}
          type="button"
          className={`onboarding-step ${s.done ? "done" : ""}`}
          onClick={s.done ? undefined : s.action}
          disabled={s.done || !s.action}
        >
          <span className="onboarding-check">{s.done ? <IconCheck size={13} /> : <span>{i + 1}</span>}</span>
          <span className="onboarding-text">
            <strong>{s.label}</strong>
            <small>{s.hint}</small>
          </span>
          {!s.done && s.cta ? (
            <span className="onboarding-cta">
              {s.cta}
              <IconChevronRight size={13} />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
