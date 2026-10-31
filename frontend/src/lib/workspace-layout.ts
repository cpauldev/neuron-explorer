import type { WorkspacePanel } from "../types";

export const COMPACT_WORKSPACE = "(max-width: 1099px)";
export const MOBILE_WORKSPACE = "(max-width: 767px)";

export function visiblePanels(
  assistantOpen: boolean,
  toolsOpen: boolean,
  activePanel: WorkspacePanel | null,
  compact: boolean,
) {
  return {
    assistant: assistantOpen && (!compact || activePanel === "assistant"),
    tools: toolsOpen && (!compact || activePanel === "tools"),
  };
}
