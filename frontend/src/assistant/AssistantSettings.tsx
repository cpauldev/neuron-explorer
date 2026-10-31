import { useState } from "react";
import { SettingsIcon } from "lucide-react";
import { useAssistant } from "../context";
import type { Provider } from "../types";
import { TooltipIconButton } from "../components/tooltip-icon-button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { ChoiceSelect } from "../components/choice-select";
import { Field, FieldLabel, FieldDescription } from "../components/ui/field";

export function AssistantSettings({ locked }: { locked: boolean }) {
  const [open, setOpen] = useState(false);
  const [s, a] = useAssistant(["provider", "access"]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<TooltipIconButton tooltip="Assistant settings" />}
      >
        <SettingsIcon aria-hidden="true" />
      </DialogTrigger>
      <DialogContent
        data-assistant-ui
        className="dark max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Assistant settings</DialogTitle>
          <DialogDescription>
            Choose your assistant and file permissions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-2">
          <Field>
            <FieldLabel htmlFor="assistant-provider">Assistant</FieldLabel>
            <ChoiceSelect
              id="assistant-provider"
              name="assistant-provider"
              aria-label="Assistant provider"
              aria-describedby="assistant-provider-description"
              className="w-full"
              value={s.provider}
              disabled={locked}
              onValueChange={(provider) =>
                a.safe(a.switchProvider(provider as Provider))
              }
              options={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude" },
              ]}
            />
            <FieldDescription id="assistant-provider-description">
              Each assistant has its own conversations.
            </FieldDescription>
          </Field>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">File access</legend>
            <RadioGroup
              aria-label="Assistant file access"
              aria-describedby="assistant-access-description"
              value={s.access}
              disabled={locked}
              onValueChange={(value) => a.access(value as "project" | "home")}
            >
              {(
                [
                  {
                    value: "project",
                    title: "Project only",
                    detail: "Read and edit files inside this project.",
                  },
                  {
                    value: "home",
                    title: "Project + home folder",
                    detail:
                      "Read and edit files in this project and your home folder.",
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-3 py-1"
                >
                  <RadioGroupItem value={option.value} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">
                      {option.title}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                      {option.detail}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <p
              id="assistant-access-description"
              className="text-muted-foreground text-xs leading-relaxed"
            >
              Commands require approval and can access files outside this scope.
            </p>
          </fieldset>
        </div>
      </DialogContent>
    </Dialog>
  );
}
