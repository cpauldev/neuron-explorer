import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ComposerModelTrigger,
  ComposerMenu,
  ComposerModelItem,
} from "../components/composer";
import { useAssistant } from "../context";
import { api } from "../lib/store";

interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

export function ComposerModelPicker() {
  const aui = useAui();
  const dictating = useAuiState((s) => s.composer.dictation !== undefined);
  const [s, a] = useAssistant(["provider", "model", "busy", "pending"]);
  const [catalog, setCatalog] = useState<{
    models: ModelChoice[];
    warning?: string;
  }>({ models: [] });
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const locked = loading || s.busy || dictating || s.pending.some((p) => !p.id);
  const expanded = open && !locked;
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ models: [] });
    setLoading(true);
    setOpen(false);
    api<{ models: ModelChoice[]; warning?: string }>(
      `/api/agent/models?provider=${s.provider}`,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setCatalog(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setCatalog({ models: [], warning: error.message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [s.provider]);
  useEffect(
    () =>
      aui.modelContext.register({
        getModelContext: () => ({
          config: s.model ? { modelName: s.model } : {},
        }),
      }),
    [aui, s.model],
  );
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
  useEffect(() => {
    if (!expanded) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [expanded]);
  const models = catalog.models?.length
    ? catalog.models
    : [
        {
          id: "default",
          name: "CLI default",
          description: "Use your configured CLI model",
        },
      ];
  const choices =
    s.model && !models.some((m) => m.id === s.model)
      ? [
          ...models,
          {
            id: s.model,
            name: s.model,
            description: "Selected for this conversation",
          },
        ]
      : models;
  const selected =
    choices.find((m) => m.id === (s.model || "default")) || choices[0];
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const navigate = (event: KeyboardEvent) => {
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab" && expanded) {
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || locked)
      return;
    event.preventDefault();
    if (!expanded) {
      setOpen(true);
      return;
    }
    const items = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) || [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  return (
    <div
      ref={root}
      className="relative"
      title={
        catalog.warning || "Applies to the next message in this conversation"
      }
      onKeyDown={navigate}
    >
      <ComposerModelTrigger
        ref={trigger}
        aria-label="Assistant model"
        aria-haspopup="menu"
        aria-controls={expanded ? menuId : undefined}
        model={selected.name}
        open={expanded}
        aria-busy={loading}
        disabled={locked}
        onClick={() => setOpen((value) => !value)}
      />
      {expanded ? (
        <ComposerMenu
          id={menuId}
          role="menu"
          aria-label="Assistant models"
          open={expanded}
          className="max-h-[min(24rem,50dvh)] overflow-y-auto"
        >
          {choices.map((model) => (
            <ComposerModelItem
              key={model.id}
              role="menuitemradio"
              aria-checked={model.id === selected.id}
              tabIndex={-1}
              title={model.description}
              entry={{ name: model.name, meta: "" }}
              selected={model.id === selected.id}
              onClick={() => {
                a.model(model.id === "default" ? null : model.id);
                close();
              }}
            />
          ))}
        </ComposerMenu>
      ) : null}
    </div>
  );
}
