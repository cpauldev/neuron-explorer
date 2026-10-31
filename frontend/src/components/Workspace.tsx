import { useLayoutEffect, useRef, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { useExplorer } from "../context";
import { readStorage, writeStorage } from "../lib/store";
import { useWorkspaceLayout } from "../lib/workspace";

function storedWidth(key: string, fallback: number) {
  const value = readStorage<number>(key);
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 320 &&
    value <= 800
    ? value
    : fallback;
}

export function Workspace({
  children,
  assistant,
  tools,
}: {
  children: ReactNode;
  assistant: ReactNode;
  tools: ReactNode;
}) {
  const [, a] = useExplorer([]);
  const layout = useWorkspaceLayout();
  const left = usePanelRef(),
    right = usePanelRef();
  const widths = useRef({
    assistant: storedWidth("explorer.assistant.width", 360),
    tools: storedWidth("explorer.tools.width", 380),
  });
  useLayoutEffect(() => {
    if (layout.assistant)
      left.current?.resize(layout.narrow ? "100%" : widths.current.assistant);
    else left.current?.collapse();
    if (layout.tools)
      right.current?.resize(layout.narrow ? "100%" : widths.current.tools);
    else right.current?.collapse();
  }, [layout.assistant, layout.tools, layout.narrow, left, right]);
  return (
    <ResizablePanelGroup
      id="explorer-workspace"
      orientation="horizontal"
      disabled={layout.narrow}
      onLayoutChanged={(_sizes, meta) => {
        if (meta.isUserInteraction && !layout.narrow) {
          writeStorage("explorer.assistant.width", widths.current.assistant);
          writeStorage("explorer.tools.width", widths.current.tools);
        }
      }}
    >
      <ResizablePanel
        id="assistant-workspace"
        panelRef={left}
        defaultSize={layout.assistant ? widths.current.assistant : 0}
        minSize={layout.narrow ? "100%" : 320}
        maxSize={layout.narrow ? "100%" : "50%"}
        collapsible
        collapsedSize={0}
        onResize={(size, _id, previous) => {
          if (!layout.narrow && size.inPixels >= 320)
            widths.current.assistant = size.inPixels;
          if (previous && size.asPercentage === 0 && layout.assistant)
            a.togglePanel("assistant", true);
        }}
      >
        {assistant}
      </ResizablePanel>
      <ResizableHandle
        aria-label="Resize assistant"
        withHandle
        disabled={!layout.assistant || layout.narrow}
        className={!layout.assistant || layout.narrow ? "hidden" : undefined}
      />
      <ResizablePanel
        id="model-workspace"
        minSize={layout.narrow ? 0 : 320}
        defaultSize="100%"
      >
        <div
          className="model-workspace"
          inert={layout.narrow && (layout.assistant || layout.tools)}
        >
          {children}
        </div>
      </ResizablePanel>
      <ResizableHandle
        aria-label="Resize tools"
        withHandle
        disabled={!layout.tools || layout.narrow}
        className={!layout.tools || layout.narrow ? "hidden" : undefined}
      />
      <ResizablePanel
        id="tools-workspace"
        panelRef={right}
        defaultSize={layout.tools ? widths.current.tools : 0}
        minSize={layout.narrow ? "100%" : 360}
        maxSize={layout.narrow ? "100%" : "55%"}
        collapsible
        collapsedSize={0}
        onResize={(size, _id, previous) => {
          if (!layout.narrow && size.inPixels >= 360)
            widths.current.tools = size.inPixels;
          if (previous && size.asPercentage === 0 && layout.tools)
            a.togglePanel("tools", true);
        }}
      >
        {tools}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
