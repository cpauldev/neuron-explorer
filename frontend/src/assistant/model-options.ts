export function modelChoices(
  catalog:
    | { models: { id: string; name: string; description?: string }[] }
    | undefined,
  selected: string | null,
) {
  const models = catalog?.models.length
    ? catalog.models
    : [{ id: "default", name: "CLI default" }];
  return selected && !models.some((m) => m.id === selected)
    ? [...models, { id: selected, name: selected }]
    : models;
}
