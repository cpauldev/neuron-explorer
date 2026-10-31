import type { Ref } from "react";
import { PanelRightCloseIcon } from "lucide-react";
import { useExplorer } from "../context";
import { useWorkspaceLayout } from "../lib/workspace";
import type { WorkbenchTab } from "../types";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { TooltipIconButton } from "./tooltip-icon-button";
import { SearchPanel, ActivationPanel } from "./Analysis";
import { SelectionPanel } from "./Inspector";
import { BuildPanel } from "./BuildPanel";

export function ExplorerTools({ panelRef }: { panelRef?: Ref<HTMLElement> }) {
  const [s, a] = useExplorer(["workbenchTab"]);
  const layout = useWorkspaceLayout();
  return (
    <Tabs
      render={<aside ref={panelRef} />}
      id="tools-sidebar"
      aria-label="Explorer tools"
      value={s.workbenchTab}
      onValueChange={(tab) => a.openTool(tab as WorkbenchTab)}
      hidden={!layout.tools}
      className="workspace-sidebar gap-0"
      onFocusCapture={() => a.set({ activePanel: "tools" })}
    >
      <div className="workspace-panel-header justify-between">
        <h2 className="text-sm font-medium">Explorer tools</h2>
        <TooltipIconButton
          tooltip="Hide tools"
          onClick={() => a.togglePanel("tools", true)}
        >
          <PanelRightCloseIcon />
        </TooltipIconButton>
      </div>
      <TabsList variant="line" className="m-2" aria-label="Explorer tools">
        {(
          [
            ["search", "Search"],
            ["analyze", "Analyze"],
            ["inspect", "Inspect"],
            ["cache", "Cache"],
          ] as const
        ).map(([tab, label]) => (
          <TabsTrigger key={tab} value={tab}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="search" keepMounted className="tool-content">
        <SearchPanel />
      </TabsContent>
      <TabsContent value="analyze" keepMounted className="tool-content">
        <ActivationPanel />
      </TabsContent>
      <TabsContent value="inspect" keepMounted className="tool-content">
        <SelectionPanel />
      </TabsContent>
      <TabsContent value="cache" className="tool-content">
        {s.workbenchTab === "cache" ? <BuildPanel /> : null}
      </TabsContent>
    </Tabs>
  );
}
