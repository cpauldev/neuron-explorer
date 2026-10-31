import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useExplorer } from "../context";
import {
  visiblePanels,
  COMPACT_WORKSPACE,
  MOBILE_WORKSPACE,
} from "./workspace-layout";
export { visiblePanels } from "./workspace-layout";

function useMedia(query: string) {
  const media = useMemo(() => matchMedia(query), [query]);
  const subscribe = useCallback(
    (callback: () => void) => {
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    [media],
  );
  return useSyncExternalStore(subscribe, () => media.matches);
}

export function useWorkspaceLayout() {
  const [s] = useExplorer(["assistantOpen", "toolsOpen", "activePanel"]);
  const compact = useMedia(COMPACT_WORKSPACE);
  const narrow = useMedia(MOBILE_WORKSPACE);
  return {
    ...visiblePanels(s.assistantOpen, s.toolsOpen, s.activePanel, compact),
    compact,
    narrow,
  };
}
