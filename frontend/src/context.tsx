import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { Store } from "./lib/store";
import type {
  ExplorerStore,
  AssistantStore,
  ExplorerState,
  AssistantState,
} from "./types";

export const ExplorerContext = createContext<ExplorerStore | null>(null);
export const AssistantContext = createContext<AssistantStore | null>(null);
export function useStore<T, K extends keyof T>(
  store: Store<T>,
  fields?: readonly K[],
): Pick<T, K> {
  const cache = useRef<Pick<T, K> | null>(null);
  const snapshot = () => {
    const state = store.getSnapshot();
    if (!fields) return state;
    if (
      !cache.current ||
      fields.some((key) => cache.current![key] !== state[key])
    )
      cache.current = Object.fromEntries(
        fields.map((key) => [key, state[key]]),
      ) as Pick<T, K>;
    return cache.current;
  };
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
export function useExplorer<K extends keyof ExplorerState>(
  fields: readonly K[],
) {
  const store = useContext(ExplorerContext);
  if (!store) throw new Error("Explorer provider is missing.");
  return [useStore(store, fields), store.actions] as const;
}
export function useAssistant<K extends keyof AssistantState>(
  fields: readonly K[],
) {
  const store = useContext(AssistantContext);
  if (!store) throw new Error("Assistant provider is missing.");
  return [useStore(store, fields), store.actions] as const;
}
