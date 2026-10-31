import { lazy, Suspense, useEffect, useState, type Ref } from "react";
import { useExplorer } from "../context";
import { useWorkspaceLayout } from "../lib/workspace";
import { Slot } from "./explorer-ui";

const AssistantPanel = lazy(() =>
  import("../assistant/AssistantPanel").then((module) => ({
    default: module.AssistantPanel,
  })),
);

export function AssistantSidebar({
  panelRef,
}: {
  panelRef?: Ref<HTMLElement>;
}) {
  const layout = useWorkspaceLayout();
  const [, a] = useExplorer([]);
  const [visited, setVisited] = useState(layout.assistant);
  useEffect(() => {
    if (layout.assistant) setVisited(true);
  }, [layout.assistant]);
  return (
    <aside
      id="assistant-sidebar"
      ref={panelRef}
      aria-label="Assistant"
      hidden={!layout.assistant}
      className="workspace-sidebar"
      onFocusCapture={() => a.set({ activePanel: "assistant" })}
    >
      {visited || layout.assistant ? (
        <Suspense fallback={<Slot>Loading assistant…</Slot>}>
          <AssistantPanel active={layout.assistant} />
        </Suspense>
      ) : null}
    </aside>
  );
}
