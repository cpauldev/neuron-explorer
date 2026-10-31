import { useCallback, useContext, useSyncExternalStore } from "react";
import { AssistantContext } from "../context";
import type { AssistantState } from "../types";

export function assistantActivity(
  state: Pick<AssistantState, "busy" | "messages">,
) {
  if (!state.busy) return "idle";
  const current = state.messages.findLast(
    (message) => message.role === "assistant",
  );
  return current?.metadata.custom.approvals?.some(
    (approval) => approval.state === "request",
  )
    ? "approval"
    : "working";
}

export function useAssistantActivity() {
  const store = useContext(AssistantContext)!;
  const snapshot = useCallback(
    () => assistantActivity(store.getSnapshot()),
    [store],
  );
  return useSyncExternalStore(store.subscribe, snapshot);
}
