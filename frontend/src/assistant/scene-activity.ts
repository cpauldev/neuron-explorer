import type { Architecture, JournalEvent, SelectionContext } from "../types";
import { isRecord } from "./research";

export interface SceneActivity {
  action:
    | "Reading"
    | "Measuring"
    | "Testing"
    | "Comparing"
    | "Investigating"
    | "Reviewing";
  targets: SelectionContext[];
}

const READ_NEURON = new Set([
  "neuron",
  "rollouts",
  "cone",
  "web_summary",
  "neuron_heads",
  "attn_drive",
]);
const READ_HEAD = new Set(["head", "attention", "head_neurons"]);
const identity = (target: SelectionContext) =>
  `${target.kind}/${target.layer}/${target.n}`;

/** Tool arguments identify actual subjects, never the potentially huge returned search results. */
export function sceneActivityForTool(
  name: string,
  input: unknown,
  arch: Architecture,
): SceneActivity | null {
  if (!isRecord(input)) return null;
  const tool = name.split("__").at(-1)!;
  let action: SceneActivity["action"];
  let items: unknown[];
  if (READ_NEURON.has(tool) || tool === "activations") {
    action = tool === "activations" ? "Measuring" : "Reading";
    items = [{ ...input, kind: "neuron" }];
  } else if (READ_HEAD.has(tool)) {
    action = tool === "attention" ? "Measuring" : "Reading";
    items = [{ ...input, n: input.head, kind: "head" }];
  } else if (tool === "compare" || tool === "steer" || tool === "logprobs") {
    action = tool === "compare" ? "Comparing" : "Testing";
    items = Array.isArray(input.neurons)
      ? input.neurons
      : input.n !== undefined
        ? [input]
        : [];
    items = [...items, ...(Array.isArray(input.heads) ? input.heads : [])];
  } else return null;
  const targets: SelectionContext[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || item.all || !Number.isInteger(item.layer)) continue;
    const layer = Number(item.layer);
    const kind =
      item.kind === "head" || item.head !== undefined ? "head" : "neuron";
    const n = Number(kind === "head" ? (item.head ?? item.n) : item.n);
    const count =
      kind === "neuron"
        ? arch.inter
        : arch.layer_types[layer] === "full_attention"
          ? arch.attn_heads
          : arch.linear_v_heads;
    if (
      layer < 0 ||
      layer >= arch.n_layers ||
      !Number.isInteger(n) ||
      n < 0 ||
      n >= count
    )
      continue;
    const target = { layer, n, kind } as SelectionContext;
    const key = identity(target);
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }
  return targets.length ? { action, targets } : null;
}

/** One live-turn controller. Settled histories never animate; concurrent subjects stay a set. */
export function createSceneActivity(
  arch: Architecture,
  display: (focus: SceneActivity | null) => void,
) {
  const pending = new Map<string, SceneActivity | null>();
  let reviewing: SceneActivity | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  function publish(immediate = false) {
    clearTimeout(timer);
    const active = [...pending.values()].filter(
      (value): value is SceneActivity => !!value,
    );
    const focus = active.length
      ? {
          action: active.every((item) => item.action === active[0].action)
            ? active[0].action
            : ("Investigating" as const),
          targets: [
            ...new Map(
              active
                .flatMap((item) => item.targets)
                .map((target) => [identity(target), target]),
            ).values(),
          ],
        }
      : pending.size
        ? null
        : reviewing;
    const signature = JSON.stringify(focus);
    if (signature === last) return;
    const commit = () => {
      last = signature;
      display(focus);
    };
    if (!focus || immediate) commit();
    else timer = setTimeout(commit, 120);
  }
  function clear(notify = true) {
    clearTimeout(timer);
    pending.clear();
    reviewing = null;
    last = "";
    if (notify) display(null);
  }
  function apply(event: JournalEvent, silent = false) {
    if (
      ["user", "done", "stopped", "error"].includes(event.t) ||
      (event.t === "text_phase" && event.phase === "final_answer")
    ) {
      clear(!silent);
      return;
    }
    if (event.t === "tool" && event.id) {
      pending.set(
        event.id,
        sceneActivityForTool(event.name, event.input, arch),
      );
      reviewing = null;
    } else if (event.t === "tool_result") {
      const finished = pending.get(event.id);
      pending.delete(event.id);
      reviewing =
        finished && !event.error ? { ...finished, action: "Reviewing" } : null;
    } else return;
    if (!silent) publish();
  }
  return {
    apply,
    clear,
    restore(events: JournalEvent[]) {
      clear(false);
      for (const event of events) apply(event, true);
      publish();
    },
  };
}
