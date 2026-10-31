import { SlidersHorizontalIcon, ScanIcon } from "lucide-react";
import { useExplorer } from "../context";
import { TabsList, TabsTrigger } from "./ui/tabs";
import { ChoiceSelect } from "./choice-select";
import { Field, FieldLabel } from "./ui/field";
import { useWorkspaceLayout } from "../lib/workspace";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { TooltipIconButton } from "./tooltip-icon-button";
import { refLabel } from "../lib/store";

export function CanvasControls() {
  const [s, a] = useExplorer([
    "view",
    "arch",
    "index",
    "layer",
    "layerMode",
    "layout",
    "webOn",
    "webZ",
    "colorBy",
  ]);
  return (
    <div className="canvas-toolbar">
      <TabsList aria-label="Explorer view">
        <TabsTrigger value="map">Map</TabsTrigger>
        <TabsTrigger value="embed">Embeddings</TabsTrigger>
      </TabsList>
      <div className="flex items-center gap-2">
        <ChoiceSelect
          id="layer"
          aria-label="Layer"
          value={s.view === "map" ? (s.layerMode ?? -1) : s.layer}
          onValueChange={(layer) =>
            layer === -1 ? a.exitLayer() : a.enterLayer(layer)
          }
          options={[
            ...(s.view === "map" ? [{ value: -1, label: "All layers" }] : []),
            ...Array.from({ length: s.arch.n_layers }, (_, layer) => ({
              value: layer,
              label: `L${layer}${s.index.layers[layer] ? " · saved" : ""}`,
            })),
          ]}
        />
      </div>
      {s.view === "map" ? (
        <>
          <TooltipIconButton tooltip="Reset map view" onClick={a.resetView}>
            <ScanIcon />
          </TooltipIconButton>
          <Popover>
            <PopoverTrigger
              aria-label="Map display options"
              title="Map display options"
              render={
                <Button variant="outline" size="sm" className="ml-auto" />
              }
            >
              <SlidersHorizontalIcon aria-hidden="true" />
              <span className="canvas-display-label">Display</span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-4">
              <h2 className="text-sm font-medium">Map display</h2>
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
              <div className="space-y-2">
                <label className="flex items-center justify-between gap-4 text-sm">
                  Show connections
                  <Switch
                    checked={s.webOn}
                    onCheckedChange={(checked) => a.setWeb({ webOn: checked })}
                  />
                </label>
              </div>
              <Field>
                <FieldLabel htmlFor="web-z">Links per direction</FieldLabel>
                <Input
                  id="web-z"
                  type="number"
                  min={1}
                  max={24}
                  value={s.webZ}
                  disabled={!s.webOn}
                  onChange={(event) => a.setWeb({ webZ: event.target.value })}
                />
              </Field>
            </PopoverContent>
          </Popover>
        </>
      ) : (
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="color-by" className="text-xs text-muted-foreground">
            Color by
          </label>
          <ChoiceSelect
            id="color-by"
            aria-label="Color by"
            value={s.colorBy}
            onValueChange={a.color}
            options={["neuron", "prompt", "dose", "kind"].map((value) => ({
              value,
              label:
                value === "kind"
                  ? "Control type"
                  : value[0].toUpperCase() + value.slice(1),
            }))}
          />
        </div>
      )}
    </div>
  );
}

export function CanvasStatus() {
  const [s, a] = useExplorer(["focus", "analysisMode", "view", "layer", "inf"]);
  const layout = useWorkspaceLayout();
  const context =
    s.view === "embed"
      ? `Saved rollout embeddings · L${s.layer}`
      : s.analysisMode === "build"
        ? "Cache coverage · colors show saved analysis, not activation."
        : s.analysisMode === "run" && s.inf.text
          ? "Text activations · select a token in Analyze to focus its activity."
          : "";
  if (!context && (!s.focus || layout.tools)) return null;
  return (
    <div className="canvas-caption">
      <span>{context}</span>
      {s.focus && !layout.tools ? (
        <Button variant="link" size="xs" onClick={() => a.openTool("inspect")}>
          Inspect {refLabel(s.focus)}
        </Button>
      ) : null}
    </div>
  );
}
