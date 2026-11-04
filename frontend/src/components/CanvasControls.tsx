import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  WrenchIcon,
  CircleAlertIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { useExplorer } from "../context";
import { TabsList, TabsTrigger } from "./ui/tabs";
import { ChoiceSelect } from "./choice-select";
import { useWorkspaceLayout } from "../lib/workspace";
import { Button } from "./ui/button";
import { useAssistantActivity } from "../assistant/activity";
import { refLabel } from "../lib/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

export function CanvasControls() {
  const [s, a] = useExplorer([
    "view",
    "arch",
    "index",
    "layer",
    "layerMode",
    "focus",
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
          <Button variant="outline" size="sm" onClick={a.resetView}>
            Reset view
          </Button>
          {s.focus && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto rounded-full"
                    aria-label={`Clear selection: ${refLabel(s.focus)}`}
                    onClick={a.closeFocus}
                  />
                }
              >
                <span className="font-mono text-xs">{refLabel(s.focus)}</span>
                <XIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Clear selection</TooltipContent>
            </Tooltip>
          )}
        </>
      ) : null}
    </div>
  );
}

export function ScenePanelOpeners() {
  const [, a] = useExplorer([]);
  const layout = useWorkspaceLayout();
  const activity = useAssistantActivity();
  return (
    <nav className="scene-panel-openers" aria-label="Workspace panels">
      <div>
        {!layout.assistant && (
          <Button
            variant="outline"
            size="sm"
            aria-label="Open chat"
            aria-expanded={false}
            aria-controls="assistant-sidebar"
            title={
              activity === "approval"
                ? "Command approval requested"
                : activity === "working"
                  ? "Assistant is working"
                  : undefined
            }
            onClick={a.openAssistant}
          >
            {activity === "approval" ? (
              <CircleAlertIcon aria-hidden="true" />
            ) : activity === "working" ? (
              <Loader2Icon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <BotIcon aria-hidden="true" />
            )}
            Chat
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        )}
      </div>
      <div>
        {!layout.tools && (
          <Button
            variant="outline"
            size="sm"
            aria-label="Open workbench"
            aria-expanded={false}
            aria-controls="tools-sidebar"
            onClick={() => a.togglePanel("tools", false)}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Workbench
            <WrenchIcon aria-hidden="true" />
          </Button>
        )}
      </div>
    </nav>
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
