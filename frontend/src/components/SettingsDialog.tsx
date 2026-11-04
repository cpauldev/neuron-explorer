import { useState } from "react";
import { SettingsIcon, PaletteIcon, BotIcon, NetworkIcon } from "lucide-react";
import { useExplorer } from "../context";
import { AssistantSettings } from "../assistant/AssistantSettings";
import { ModeToggle } from "./mode-toggle";
import { ChoiceSelect } from "./choice-select";
import { Button } from "./ui/button";
import { TooltipIconButton } from "./tooltip-icon-button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { SceneColorSettings } from "./SceneColorSettings";

const sections = [
  {
    id: "appearance",
    label: "Appearance",
    icon: PaletteIcon,
  },
  {
    id: "assistant",
    label: "Chat",
    icon: BotIcon,
  },
  {
    id: "visualization",
    label: "Visualization",
    icon: NetworkIcon,
  },
] as const;
type Section = (typeof sections)[number]["id"];

function VisualizationSettings() {
  const [s, a] = useExplorer(["layout", "webOn", "webZ", "colorBy"]);
  return (
    <div className="space-y-7">
      <div className="space-y-5">
        <h3 className="text-sm font-semibold">Model map</h3>
        <Field>
          <FieldLabel htmlFor="map-layout">Arrange neurons by</FieldLabel>
          <ChoiceSelect
            id="map-layout"
            className="w-full"
            value={s.layout}
            onValueChange={(value) => a.safe(a.setLayout(value))}
            options={[
              { value: "index", label: "Neuron index" },
              { value: "writes", label: "Writing direction" },
              { value: "reads", label: "Reading direction" },
            ]}
          />
        </Field>
        <Field
          orientation="horizontal"
          className="items-center justify-between"
        >
          <div className="space-y-1">
            <FieldLabel htmlFor="show-connections">Show connections</FieldLabel>
          </div>
          <Switch
            id="show-connections"
            checked={s.webOn}
            onCheckedChange={(checked) => a.setWeb({ webOn: checked })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="web-z">Links per direction (1–24)</FieldLabel>
          <Input
            id="web-z"
            type="number"
            min={1}
            max={24}
            className="w-24"
            value={s.webZ}
            disabled={!s.webOn}
            onChange={(event) => a.setWeb({ webZ: event.target.value })}
          />
        </Field>
      </div>
      <div className="space-y-5 border-t border-border pt-6">
        <h3 className="text-sm font-semibold">Embeddings</h3>
        <Field>
          <FieldLabel htmlFor="color-by">Color by</FieldLabel>
          <ChoiceSelect
            id="color-by"
            aria-label="Color by"
            className="w-full"
            value={s.colorBy}
            onValueChange={a.color}
            options={[
              { value: "neuron", label: "Neuron" },
              { value: "prompt", label: "Prompt" },
              { value: "dose", label: "Dose" },
              { value: "kind", label: "Control type" },
            ]}
          />
        </Field>
      </div>
      <SceneColorSettings />
    </div>
  );
}

export function SettingsDialog() {
  const [section, setSection] = useState<Section>("appearance");
  const current = sections.find((item) => item.id === section)!;
  return (
    <Dialog>
      <DialogTrigger
        render={
          <TooltipIconButton tooltip="Settings" className="ml-auto size-8" />
        }
      >
        <SettingsIcon aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="settings-dialog gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        <DialogHeader className="border-b border-border px-6 py-5 pr-12">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Appearance, chat, and visualization preferences.
          </DialogDescription>
        </DialogHeader>
        <div className="settings-body">
          <nav aria-label="Settings sections" className="settings-nav">
            {sections.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant="ghost"
                className={`settings-nav-item ${section === id ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                aria-current={section === id ? "page" : undefined}
                aria-controls="settings-options"
                onClick={() => setSection(id)}
              >
                <Icon aria-hidden="true" />
                {label}
              </Button>
            ))}
          </nav>
          <section
            id="settings-options"
            aria-labelledby="settings-section-heading"
            className="settings-options"
            key={section}
          >
            <div className="mb-7 space-y-2">
              <h2
                id="settings-section-heading"
                className="text-base font-semibold"
              >
                {current.label}
              </h2>
            </div>
            {section === "appearance" && (
              <Field>
                <FieldLabel htmlFor="color-theme">Color theme</FieldLabel>
                <div>
                  <ModeToggle />
                </div>
              </Field>
            )}
            {section === "assistant" && <AssistantSettings />}
            {section === "visualization" && <VisualizationSettings />}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
