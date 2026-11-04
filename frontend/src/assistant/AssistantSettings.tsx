import { useAssistant } from "../context";
import type { Provider } from "../types";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { ChoiceSelect } from "../components/choice-select";
import { Field, FieldLabel, FieldDescription } from "../components/ui/field";
import { AssistantModelSettings } from "./AssistantModelSettings";
import { Switch } from "../components/ui/switch";

export function AssistantSettings() {
  const [s, a] = useAssistant([
    "provider",
    "access",
    "busy",
    "pending",
    "dictating",
    "includeSelection",
  ]);
  const locked = s.busy || !!s.dictating || s.pending.some((p) => !p.id);
  return (
    <div className="space-y-6">
      {locked && (
        <p
          role="status"
          className="rounded-lg bg-muted p-3 text-xs text-muted-foreground"
        >
          Finish the reply, recording, or upload to change these settings.
        </p>
      )}
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
      <AssistantModelSettings />
      <Field orientation="horizontal" className="items-center justify-between">
        <div className="space-y-1">
          <FieldLabel htmlFor="assistant-selection">
            Include selected neuron or head
          </FieldLabel>
        </div>
        <Switch
          id="assistant-selection"
          checked={s.includeSelection}
          onCheckedChange={a.includeSelection}
        />
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
              },
              {
                value: "home",
                title: "Project + home folder",
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
  );
}
