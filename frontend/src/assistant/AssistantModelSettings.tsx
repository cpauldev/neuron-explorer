import { useEffect } from "react";
import { ChoiceSelect } from "../components/choice-select";
import { Field, FieldLabel, FieldDescription } from "../components/ui/field";
import { useAssistant } from "../context";
import { modelChoices } from "./model-options";

export function AssistantModelSettings() {
  const [s, a] = useAssistant([
    "provider",
    "modelCatalogs",
    "model",
    "busy",
    "pending",
    "dictating",
  ]);
  const catalog = s.modelCatalogs[s.provider];
  const loading = !catalog;
  const locked =
    loading || s.busy || !!s.dictating || s.pending.some((p) => !p.id);
  useEffect(() => {
    void a.loadModels(s.provider);
  }, [a, s.provider]);
  const choices = modelChoices(catalog, s.model);
  return (
    <Field>
      <FieldLabel htmlFor="assistant-model">Model</FieldLabel>
      <ChoiceSelect
        id="assistant-model"
        aria-label="Assistant model"
        value={s.model || "default"}
        disabled={locked}
        aria-busy={loading}
        className="w-full"
        onValueChange={(value) => a.model(value === "default" ? null : value)}
        options={choices.map((model) => ({
          value: model.id,
          label: model.name,
        }))}
      />
      <FieldDescription>Applies to your next message.</FieldDescription>
      {catalog?.warning && (
        <p role="status" className="text-xs text-destructive">
          {catalog?.warning}
        </p>
      )}
    </Field>
  );
}
