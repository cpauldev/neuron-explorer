export interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  set(patch: Partial<T> | ((state: T) => Partial<T>)): T;
}
export function createStore<T>(initial: T): Store<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      snapshot = {
        ...snapshot,
        ...(typeof patch === "function" ? patch(snapshot) : patch),
      };
      for (const listener of listeners) listener();
      return snapshot;
    },
  };
}

// Endpoints with a fixed response pass their response type; scientific endpoints
// are narrowed to domain records at their callers.
export async function api<T = any>(
  path: string,
  body?: unknown,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    ...options,
  });
  if (!response.ok)
    throw new Error(
      `${path.split("?")[0]} ${response.status}: ${(await response.text()).slice(0, 160)}`,
    );
  const data = await response.json();
  if (data.error) throw new Error(String(data.error));
  return data;
}

export function readStorage<T = unknown>(
  key: string,
  fallback: T | null = null,
): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable. */
  }
}
export const fmtDose = (d: number) =>
  (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d);
export const refLabel = (f: import("../types").Focus | null) =>
  f
    ? `L${f.layer} ${f.kind === "head" ? "h" : f.kind === "random" ? "random " : "N"}${f.n}`
    : "";
export const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

// The server sends both SSE (local inference) and NDJSON (assistant journal).
export async function readSSE(
  response: Response,
  onEvent: (event: { row?: number; t?: string; error?: string }) => void,
) {
  if (!response.ok)
    throw new Error(
      `${response.status}: ${(await response.text()).slice(0, 160)}`,
    );
  if (!response.body) throw new Error("The response has no event stream.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) onEvent(JSON.parse(data));
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
