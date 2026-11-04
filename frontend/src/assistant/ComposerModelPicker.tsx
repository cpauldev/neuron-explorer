import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  ComposerMenu,
  ComposerModelItem,
  ComposerModelTrigger,
} from "../components/composer";
import { useAssistant } from "../context";
import { modelChoices } from "./model-options";
import type { Provider } from "../types";

const providers: { id: Provider; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
];

export function ComposerModelPicker() {
  const [s, a] = useAssistant([
    "provider",
    "model",
    "modelCatalogs",
    "busy",
    "loading",
    "dictating",
    "pending",
    "deletingChat",
  ]);
  const [open, setOpen] = useState(false);
  const locked =
    s.busy ||
    s.loading ||
    !!s.dictating ||
    !!s.deletingChat ||
    s.pending.some((p) => !p.id);
  const current = modelChoices(s.modelCatalogs[s.provider], s.model).find(
    (m) => m.id === (s.model || "default"),
  )!;
  const providerName = providers.find((p) => p.id === s.provider)!.name;
  const label = current.name.startsWith(providerName)
    ? current.name
    : `${providerName} · ${current.name}`;
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
  function changeOpen(value: boolean) {
    setOpen(value);
    if (value)
      for (const provider of providers) void a.loadModels(provider.id, true);
  }
  return (
    <Menu.Root open={open} onOpenChange={changeOpen}>
      <Menu.Trigger
        render={
          <ComposerModelTrigger
            model={label}
            open={open}
            disabled={locked}
            aria-label={`Chat model: ${label}`}
          />
        }
      />
      <Menu.Portal>
        <Menu.Positioner
          side="top"
          align="start"
          sideOffset={8}
          className="z-50"
        >
          <Menu.Popup
            render={
              <ComposerMenu
                open={open}
                className="static bottom-auto start-auto mb-0 max-h-[min(24rem,50dvh)] overflow-y-auto"
                style={{ translate: "none" }}
              />
            }
          >
            <Menu.RadioGroup
              value={`${s.provider}/${s.model || "default"}`}
              onValueChange={(value: string) => {
                const [provider, ...parts] = value.split("/");
                const model = parts.join("/");
                a.safe(
                  a.switchProvider(
                    provider as Provider,
                    model === "default" ? null : model,
                  ),
                );
              }}
            >
              {providers.map((provider) => {
                const catalog = s.modelCatalogs[provider.id];
                return (
                  <Menu.Group key={provider.id}>
                    <Menu.GroupLabel className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
                      {provider.name}
                    </Menu.GroupLabel>
                    {modelChoices(
                      catalog,
                      provider.id === s.provider ? s.model : null,
                    ).map((model) => (
                      <Menu.RadioItem
                        key={model.id}
                        value={`${provider.id}/${model.id}`}
                        label={model.name}
                        nativeButton
                        closeOnClick
                        render={
                          <ComposerModelItem
                            entry={{ name: model.name, meta: "" }}
                            selected={
                              provider.id === s.provider &&
                              model.id === (s.model || "default")
                            }
                            className="data-highlighted:bg-accent"
                          />
                        }
                      />
                    ))}
                    {!catalog && (
                      <p
                        role="status"
                        className="px-2.5 py-1 text-xs text-muted-foreground"
                      >
                        Loading models…
                      </p>
                    )}
                    {catalog?.warning && (
                      <p
                        role="status"
                        className="px-2.5 py-1 text-xs text-muted-foreground"
                      >
                        {catalog.warning}
                      </p>
                    )}
                  </Menu.Group>
                );
              })}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
