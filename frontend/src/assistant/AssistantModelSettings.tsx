import { useEffect, useState } from "react";
import { ChoiceSelect } from "../components/choice-select";
import { Field, FieldLabel, FieldDescription } from "../components/ui/field";
import { useAssistant } from "../context";
import { api } from "../lib/store";

interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

export function AssistantModelSettings() {
  const [s, a] = useAssistant([
    "provider",
    "model",
    "busy",
    "pending",
    "dictating",
  ]);
  const [catalog, setCatalog] = useState<{
    models: ModelChoice[];
    warning?: string;
  }>({ models: [] });
  const [loading, setLoading] = useState(true);
  const locked =
    loading || s.busy || !!s.dictating || s.pending.some((p) => !p.id);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ models: [] });
    setLoading(true);
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
      {catalog.warning && (
        <p role="status" className="text-xs text-destructive">
          {catalog.warning}
        </p>
      )}
    </Field>
  );
}
