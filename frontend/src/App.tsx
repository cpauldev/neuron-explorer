import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { ExplorerStore, AssistantStore, ModelIndex } from "./types";
import { ExplorerContext, AssistantContext, useExplorer } from "./context";
import { createExplorer } from "./explorer";
import { createAssistant } from "./assistant/store";
import { api } from "./lib/store";
import {
  Toolbar,
  WorkspaceNotice,
  AssistantApprovalNotice,
} from "./components/Toolbar";
import { ExplorerTools } from "./components/ExplorerTools";
import { AssistantSidebar } from "./components/AssistantSidebar";
import { CanvasControls, CanvasStatus } from "./components/CanvasControls";
import { Tooltip, Viewport } from "./components/Viewport";
import { Workspace } from "./components/Workspace";
import { Tabs } from "./components/ui/tabs";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";

function Explorer({
  assistant,
}: {
  explorer: ExplorerStore;
  assistant: AssistantStore;
}) {
  const [s, a] = useExplorer(["view"]);
  const map = useRef<HTMLCanvasElement>(null),
    labels = useRef<HTMLDivElement>(null),
    scatter = useRef<HTMLCanvasElement>(null),
    left = useRef<HTMLElement>(null),
    right = useRef<HTMLElement>(null);
  useEffect(() => {
    a.safe(
      a.attach({
        mapCanvas: map.current!,
        labels: labels.current!,
        scatterCanvas: scatter.current!,
        leftPanel: left.current!,
        rightPanel: right.current!,
      }),
    );
    assistant.actions.start();
    const fail = (e: PromiseRejectionEvent) =>
      a.set({ status: String(e.reason?.message || e.reason) });
    const save = () => {
      a.flushName();
    };
    addEventListener("unhandledrejection", fail);
    addEventListener("pagehide", save);
    return () => {
      a.dispose();
      assistant.actions.dispose();
      removeEventListener("unhandledrejection", fail);
      removeEventListener("pagehide", save);
    };
  }, [a, assistant]);
  return (
    <Tabs
      value={s.view}
      onValueChange={(view) => a.setView(view as "map" | "embed")}
      className="app-shell gap-0"
    >
      <Toolbar />
      <main id="workspace" aria-label="Model workspace">
        <Workspace
          assistant={<AssistantSidebar panelRef={left} />}
          tools={<ExplorerTools panelRef={right} />}
        >
          <CanvasControls />
          <div className="canvas-scene">
            <Viewport mapRef={map} labelsRef={labels} scatterRef={scatter} />
          </div>
          <CanvasStatus />
        </Workspace>
      </main>
      <WorkspaceNotice />
      <AssistantApprovalNotice />
      <Tooltip />
    </Tabs>
  );
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div className="startup-state" role="alert">
        <h1>Could not display the explorer</h1>
        <p>{this.state.error.message}</p>
        <Button onClick={() => location.reload()}>Reload</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  const [loaded, setLoaded] = useState<{
      explorer: ExplorerStore;
      assistant: AssistantStore;
    } | null>(null),
    [error, setError] = useState(""),
    [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<ModelIndex>("/api/index", undefined, {
      signal: controller.signal,
    }).then(
      (index) => {
        if (controller.signal.aborted) return;
        const explorer = createExplorer(index),
          assistant = createAssistant(explorer);
        setLoaded({ explorer, assistant });
      },
      (error) => {
        if (error.name !== "AbortError") setError(error.message);
      },
    );
    return () => controller.abort();
  }, [attempt]);
  if (!loaded)
    return (
      <div className="startup-state" role="status">
        <h1>Neuron Explorer</h1>
        <p>{error || "Loading model architecture…"}</p>
        {error ? (
          <Button onClick={() => retry((n) => n + 1)}>Retry connection</Button>
        ) : null}
      </div>
    );
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <ExplorerContext.Provider value={loaded.explorer}>
          <AssistantContext.Provider value={loaded.assistant}>
            <Explorer {...loaded} />
          </AssistantContext.Provider>
        </ExplorerContext.Provider>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
