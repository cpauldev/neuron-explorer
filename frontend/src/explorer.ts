import type {
  ExplorerState,
  ModelIndex,
  HeadInfo,
  NeuronHeads,
  HeadRole,
  Focus,
  SelectionKind,
  SelectionOptions,
  LocalChatState,
  ChatControls,
  ChatTurn,
  NeuronName,
  UiEvent,
  Pick,
} from "./types";
import {
  createStore,
  api,
  readStorage,
  writeStorage,
  readSSE,
  refLabel,
} from "./lib/store";
import {
  parseDose,
  createChatUiController,
  connectUiBridge,
} from "../../explorer/static/chat_ui.js";
import { visiblePanels, COMPACT_WORKSPACE } from "./lib/workspace-layout";

export const ROLE_COL = {
  q: "#73ff8c",
  k: "#b399ff",
  v: "#66d9ff",
  o: "#66d9ff",
};
export const ROLE_LABEL = { q: "query", k: "key", v: "value", o: "output" };
export const headRoleLinks = (h: HeadInfo) =>
  (
    [
      ["q", h.q],
      ["k", h.k],
      ["v", h.reads],
      ["o", h.writes],
    ] as const
  ).flatMap(([role, list]) =>
    (list || [])
      .slice(0, 5)
      .map((c) => ({ ...c, role, side: role === "o" ? "down" : "up" })),
  );
export function roleHeads(r: NeuronHeads) {
  const seen = new Set();
  return (["q", "k", "v", "o"] as const)
    .flatMap((role) => (r?.roles?.[role] || []).map((x) => ({ ...x, role })))
    .filter((x) => x.z >= 3)
    .sort((a, b) => b.z - a.z)
    .filter(
      (x) =>
        !seen.has(`${x.layer}/${x.head}`) && seen.add(`${x.layer}/${x.head}`),
    );
}
const ADD_STEPS = [
  ...Array.from({ length: 30 }, (_, i) => +((i + 1) * 0.05).toFixed(2)),
  1.75,
  2,
  2.5,
  3,
  4,
  5,
];
const MUL_STEPS = [
  ...Array.from({ length: 9 }, (_, i) => i * 0.5),
  5,
  6,
  8,
  12,
  16,
];

export function createExplorer(index: ModelIndex) {
  const arch = index.arch,
    modelKey = (key: string) =>
      index.cache_key ? `${key}.${index.cache_key}` : key;
  const have = Object.keys(index.layers).map(Number),
    saved = readStorage<number>(modelKey("ne.layer"));
  const first =
    saved !== null &&
    Number.isInteger(saved) &&
    saved >= 0 &&
    saved < arch.n_layers
      ? saved
      : have.includes(22)
        ? 22
        : (have[0] ?? 0);
  const store = createStore<ExplorerState>({
    index,
    arch,
    layer: first,
    units: {},
    focus: null,
    name: "",
    nameSaved: false,
    view: "map",
    layout: "writes",
    layerMode: null,
    webOn: true,
    webZ: "5",
    webSum: null,
    analysisMode: new URLSearchParams(location.search).has("build")
      ? "build"
      : "net",
    mapReady: false,
    assistantOpen: true,
    toolsOpen: true,
    activePanel: new URLSearchParams(location.search).has("build")
      ? "tools"
      : typeof matchMedia === "function" &&
          matchMedia("(min-width: 768px)").matches
        ? "assistant"
        : null,
    workbenchTab: new URLSearchParams(location.search).has("build")
      ? "cache"
      : "search",
    tab: "agent",
    selectionTab: "details",
    fresh: {},
    lensQuery: "",
    analysisText: "",
    filter: "",
    showRandom: false,
    lensResults: null,
    fireResults: null,
    inf: { text: null, pos: -1, sign: "both", tokens: [], positions: [] },
    infFilters: { lo: "0", hi: String(arch.n_layers - 1), min: "1.0", q: "" },
    tokenWeights: [],
    unit: null,
    lens: null,
    con: null,
    nheads: null,
    headInfo: null,
    headCache: {},
    loadError: "",
    lensError: "",
    conError: "",
    loading: false,
    embedLoading: false,
    embedAvailable: false,
    colorBy: "neuron",
    statusText: "",
    status: "",
    tooltip: null,
    chat: {
      mode: "add",
      dir: "writes",
      dose: { add: 0.8, mul: 2 },
      doseInput: "0.8",
      prompt: "",
      running: false,
      generation: null,
      thread: [],
      reads: null,
      error: "",
    },
  });
  const get = store.getSnapshot,
    set = store.set,
    browserId = crypto.randomUUID();
  const sessions = new Map<string, LocalChatState>(),
    layouts: Record<string, Int16Array> = {},
    hoverCache = new Map<string, any>(),
    rolloutCache = new Map<string, string>();
  let map:
      | ReturnType<typeof import("../../explorer/static/map3d.js").createMap>
      | undefined,
    scatter:
      | ReturnType<
          typeof import("../../explorer/static/scatter.js").createScatter
        >
      | undefined;
  let disposed = false,
    epoch = 0,
    lensEpoch = 0,
    queryEpoch = 0,
    viewEpoch = 0,
    headEpoch = 0,
    shadeEpoch = 0;
  let queryTimer: ReturnType<typeof setTimeout> | undefined,
    filterTimer: typeof queryTimer,
    nameTimer: typeof queryTimer,
    statusTimer: typeof queryTimer,
    hoverTimer: typeof queryTimer,
    tokenTimer: typeof queryTimer,
    pendingName: NeuronName | null = null;
  let generation: AbortController | null = null,
    selectionPending = false,
    webKey: string | null = null,
    hoverKey: string | null = null,
    tokenHover: number | null = null,
    agentMarked = false;
  let bridge: EventSource | undefined,
    observer: ResizeObserver | undefined,
    attachmentEpoch = 0;
  const safe = (promise: unknown) =>
    Promise.resolve(promise).catch(
      (error) => !disposed && set({ status: error.message }),
    );
  const chatSet = (patch: Partial<LocalChatState>) =>
    set((s) => ({ chat: { ...s.chat, ...patch } }));
  const current = (e: number, f: Focus) =>
    !disposed &&
    epoch === e &&
    get().focus?.layer === f.layer &&
    get().focus?.n === f.n &&
    get().focus?.kind === f.kind;
  const validNeuron = (layer: number, n: number) =>
    Number.isInteger(layer) &&
    Number.isInteger(n) &&
    layer >= 0 &&
    layer < arch.n_layers &&
    n >= 0 &&
    n < arch.inter;
  const validHead = (layer: number, n: number) =>
    Number.isInteger(layer) &&
    layer >= 0 &&
    layer < arch.n_layers &&
    Number.isInteger(n) &&
    n >= 0 &&
    n <
      (arch.layer_types[layer] === "full_attention"
        ? arch.attn_heads
        : arch.linear_v_heads);

  function saveSession() {
    const s = get();
    if (s.focus)
      sessions.set(
        `${s.focus.kind}/${s.focus.layer}/${s.focus.n}`,
        s.chat.running
          ? {
              ...s.chat,
              running: false,
              generation: null,
              error:
                s.chat.dir === "reads"
                  ? "reading cancelled"
                  : "generation cancelled",
              thread: s.chat.thread.map((turn) =>
                turn.live
                  ? { ...turn, live: false, error: "generation cancelled" }
                  : turn,
              ),
            }
          : s.chat,
      );
  }
  function markFresh(tab: ExplorerState["tab"]) {
    if (get().tab !== tab) set((s) => ({ fresh: { ...s.fresh, [tab]: true } }));
  }
  function setTab(tab: ExplorerState["tab"]) {
    if (tab === "agent") {
      set({ assistantOpen: true, activePanel: "assistant", tab });
      return;
    }
    const f = get().focus;
    if (
      !f ||
      (tab !== "details" && f.kind === "head") ||
      (tab === "chat" && f.kind !== "neuron")
    )
      return;
    actions.openTool("inspect");
    set((s) => ({
      tab,
      selectionTab: tab,
      workbenchTab: "inspect",
      toolsOpen: true,
      activePanel: "tools",
      fresh: { ...s.fresh, [tab]: false },
    }));
  }
  function setView(view: ExplorerState["view"]) {
    set({ view, tooltip: null });
    if (view === "embed") safe(loadEmbeddings());
  }
  async function setLayer(layer: number) {
    set({ layer });
    writeStorage(modelKey("ne.layer"), layer);
    if (scatter?.data?.layer !== layer) scatter?.setData(null);
    if (!get().units[layer]) {
      const units = index.layers[layer]
        ? await api(`/api/units?layer=${layer}`)
        : [];
      if (disposed) return;
      set((s) => ({ units: { ...s.units, [layer]: units } }));
    }
    if (get().layer !== layer || disposed) return;
    if (get().analysisMode !== "build" && get().units[layer].length)
      map?.setUnits(layer, get().units[layer]);
    if (get().view === "embed") await loadEmbeddings();
  }
  async function loadEmbeddings() {
    const layer = get().layer;
    set({ embedLoading: true });
    try {
      const d = index.layers[layer]
        ? await api(`/api/embeddings?layer=${layer}`)
        : {};
      if (disposed || get().layer !== layer || get().view !== "embed") return;
      set({ embedLoading: false, embedAvailable: Boolean(d.x) });
      scatter?.setData(d.x ? { ...d, layer } : null);
      const f = get().focus;
      scatter?.select(layer, f?.layer === layer ? f.n : null);
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      if (get().layer === layer)
        set({
          embedLoading: false,
          embedAvailable: false,
          status: error.message,
        });
    }
  }
  async function setLayout(kind: string) {
    set({ layout: kind });
    if (get().analysisMode === "build") return;
    if (kind === "index") {
      map?.setLayout(null);
      return;
    }
    if (!layouts[kind]) {
      const r = await api(`/api/layout?kind=${kind}`);
      if (get().layout !== kind || get().analysisMode === "build" || disposed)
        return;
      if (!r.available) {
        set({ layout: "index" });
        map?.setLayout(null);
        return;
      }
      const bin = atob(r.cell),
        cells = new Int16Array(bin.length / 2);
      for (let i = 0; i < cells.length; i++)
        cells[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      layouts[kind] = cells;
    }
    map?.setLayout(layouts[kind]);
  }
  async function refreshWeb() {
    const s = get(),
      f = s.focus,
      first = Math.max(1, Math.min(24, Math.round(Number(s.webZ) || 5)));
    const params = new URLSearchParams(location.search),
      k = Number(params.get("webk")) || 2,
      hops = Number(params.get("webhops")) || 0;
    if (!s.webOn || f?.kind !== "neuron") {
      webKey = null;
      set({ webSum: null });
      map?.setWeb(null);
      return;
    }
    const key = `${f.layer}/${f.n}/${first}/${k}/${hops}`;
    if (key === webKey) return;
    webKey = key;
    const args = `layer=${f.layer}&n=${f.n}&first=${first}&k=${k}&hops=${hops}`;
    const response = await fetch(`/api/web?${args}`);
    if (!response.ok || key !== webKey || disposed) return;
    const links = new Int16Array(await response.arrayBuffer());
    if (key !== webKey || disposed) return;
    map?.setWeb(links);
    const summary = await api(`/api/web/summary?${args}&top=24`);
    if (key === webKey && !disposed)
      set({
        webSum: {
          ...summary,
          layer: f.layer,
          n: f.n,
          links: response.headers.get("X-Web-Total"),
        },
      });
  }
  async function loadLive(f: Focus, e: number) {
    const args = `layer=${f.layer}&n=${f.n}`;
    const requests = [
      api(`/api/lens?${args}`).then(
        (lens) => {
          if (current(e, f)) set({ lens: { ...lens, ...f } });
        },
        (error) => {
          if (current(e, f)) set({ lensError: error.message });
        },
      ),
      api(`/api/connections?${args}&k=24`).then(
        (con) => {
          if (current(e, f)) {
            set({ con });
            if (get().analysisMode !== "build") map?.setConnections(con);
          }
        },
        (error) => {
          if (current(e, f)) set({ conError: error.message });
        },
      ),
      api<NeuronHeads>(`/api/neuron/heads?${args}`).then(
        async (nheads) => {
          if (!current(e, f)) return;
          set({ nheads: { ...nheads, ...f } });
          safe(lightHeads());
          map?.setNeuronHeads(roleHeads(nheads).slice(0, 8));
          const heads = Object.values(nheads.roles || {})
            .flat()
            .filter(
              (x) => x.z >= 2 && !hoverCache.has(`h/${x.layer}/${x.head}`),
            );
          await Promise.all(
            heads.map(async (x) => {
              const info = await api(
                `/api/head?layer=${x.layer}&head=${x.head}`,
              );
              hoverCache.set(`h/${x.layer}/${x.head}`, info);
            }),
          );
          if (current(e, f)) set({ headCache: Object.fromEntries(hoverCache) });
        },
        (error) => {
          if (current(e, f)) set({ status: error.message });
        },
      ),
    ];
    await Promise.allSettled(requests);
  }
  async function select(
    layer: number,
    n: number,
    kind: SelectionKind = "neuron",
    options: SelectionOptions = {},
  ) {
    if (
      kind === "head"
        ? !validHead(layer, n)
        : !Number.isInteger(n) ||
          n < 0 ||
          layer < 0 ||
          layer >= arch.n_layers ||
          (kind === "neuron" && !validNeuron(layer, n))
    )
      throw new Error("Selection is out of range.");
    const e = ++epoch,
      f = { layer, n, kind };
    selectionPending = true;
    saveSession();
    flushName();
    cancelChat();
    if (!options.agent) clearAgentMarks();
    const s = get(),
      previous = sessions.get(`${kind}/${layer}/${n}`);
    set({
      focus: f,
      name:
        s.units[layer]?.find((u) => u.n === n && u.kind === kind)?.name || "",
      nameSaved: false,
      loading: true,
      loadError: "",
      lensError: "",
      conError: "",
      unit: null,
      lens: null,
      con: null,
      nheads: null,
      headInfo: null,
      webSum: null,
      toolsOpen: true,
      ...(options.agent
        ? {}
        : { activePanel: "tools" as const, workbenchTab: "inspect" as const }),
      selectionTab:
        kind === "head" || (kind === "random" && s.selectionTab === "chat")
          ? "details"
          : s.selectionTab,
      tab:
        options.agent && s.tab === "agent"
          ? "agent"
          : kind === "head" || (kind === "random" && s.selectionTab === "chat")
            ? "details"
            : s.selectionTab,
      chat: {
        ...(previous || s.chat),
        thread: previous?.thread || [],
        prompt: previous?.prompt || "",
        reads: null,
        error: previous?.error || "",
        running: false,
        generation: null,
      },
    });
    writeStorage(modelKey("explorer.focus"), kind === "random" ? null : f);
    if (options.push !== false && kind !== "random")
      history.replaceState(
        null,
        "",
        `#L${layer}/${kind === "head" ? "h" : "N"}${n}`,
      );
    map?.selectHead(null);
    map?.setNeuronHeads([]);
    try {
      if (layer !== get().layer) await setLayer(layer);
      if (!current(e, f)) return;
      if (kind === "head") {
        map?.select(null);
        scatter?.select(null, null);
        map?.selectHead(layer, n);
      } else if (kind === "neuron") {
        map?.select(layer, n, options.fly !== false);
        scatter?.select(layer, n);
      }
      if (map?.layerMode !== null && map?.layerMode !== layer)
        map?.enterLayer(layer);
      safe(refreshWeb());
      safe(lightHeads());
      const unit = await api(
        kind === "head"
          ? `/api/head?layer=${layer}&head=${n}`
          : `/api/unit?layer=${layer}&n=${n}&kind=${kind}`,
      );
      if (!current(e, f)) return;
      if (kind === "head") {
        set({ headInfo: unit, loading: false });
        hoverCache.set(`h/${layer}/${n}`, unit);
        map?.setHeadLinks(layer, n, headRoleLinks(unit));
      } else {
        set({
          unit,
          loading: false,
          ...(pendingName?.layer === layer && pendingName?.n === n
            ? {}
            : { name: unit.name || "" }),
        });
        if (kind === "neuron") safe(loadLive(f, e));
      }
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      if (current(e, f)) set({ loading: false, loadError: error.message });
      throw error;
    } finally {
      if (epoch === e) selectionPending = false;
    }
  }
  function closeFocus() {
    saveSession();
    flushName();
    cancelChat();
    ++epoch;
    selectionPending = false;
    set({
      focus: null,
      selectionTab: "details",
      tab: get().activePanel === "assistant" ? "agent" : "details",
      lens: null,
      nheads: null,
      headInfo: null,
    });
    writeStorage(modelKey("explorer.focus"), null);
    history.replaceState(null, "", location.pathname + location.search);
    map?.select(null);
    map?.selectHead(null);
    map?.setNeuronHeads([]);
    scatter?.select(null, null);
    safe(refreshWeb());
    safe(lightHeads());
  }
  async function saveName(p: NeuronName) {
    await api("/api/name", p);
    if (disposed) return;
    set((s) => ({
      units: {
        ...s.units,
        [p.layer]: (s.units[p.layer] || []).map((u) =>
          u.kind === "neuron" && u.n === p.n
            ? { ...u, name: p.name.trim() }
            : u,
        ),
      },
      ...(s.focus?.layer === p.layer &&
      s.focus?.n === p.n &&
      s.focus?.kind === "neuron"
        ? { nameSaved: true }
        : {}),
    }));
    if (get().layer === p.layer && get().units[p.layer]?.length)
      map?.setUnits(p.layer, get().units[p.layer]);
  }
  function flushName() {
    clearTimeout(nameTimer);
    if (pendingName) {
      const p = pendingName;
      pendingName = null;
      safe(saveName(p));
    }
  }
  function rename(name: string) {
    const f = get().focus;
    if (f?.kind !== "neuron") return;
    name = name.replace(/\n+/g, " ");
    set({ name, nameSaved: false });
    pendingName = { layer: f.layer, n: f.n, name };
    clearTimeout(nameTimer);
    nameTimer = setTimeout(flushName, 500);
  }
  function controls(patch: ChatControls) {
    const c = get().chat;
    const mode = patch.mode || c.mode,
      dir = patch.direction
        ? patch.direction === "reads you"
          ? "reads"
          : "writes"
        : c.dir;
    const dose = {
      ...c.dose,
      ...(patch.dose !== undefined ? { [mode]: patch.dose } : {}),
    };
    chatSet({
      mode,
      dir,
      dose,
      doseInput: mode === "mul" ? `×${dose.mul}` : String(dose.add),
      error: "",
    });
  }
  function applyDose() {
    try {
      controls({ dose: parseDose(get().chat.doseInput) });
      return true;
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      chatSet({ error: error.message });
      return false;
    }
  }
  function stepDose(dir: number) {
    const c = get().chat,
      positive = c.mode === "mul" ? MUL_STEPS.filter((x) => x > 0) : ADD_STEPS;
    const steps = [...positive.map((x) => -x).reverse(), 0, ...positive],
      value = c.dose[c.mode];
    const next =
      dir > 0
        ? steps.find((x) => x > value + 1e-9)
        : steps.reverse().find((x) => x < value - 1e-9);
    if (next !== undefined) controls({ dose: next });
  }
  function cancelChat() {
    generation?.abort();
  }
  async function submitChat() {
    const s = get(),
      f = s.focus;
    if (generation)
      return { status: "error", error: "Chat generation is already running" };
    if (f?.kind !== "neuron")
      return { status: "error", error: "select a real neuron first" };
    if (!applyDose())
      return {
        status: "error",
        error: "Enter a finite dose before submitting.",
      };
    const c = get().chat,
      prompt = c.prompt.trim();
    if (!prompt)
      return { status: "error", error: "Enter a prompt before submitting." };
    const ctl = (generation = new AbortController()),
      e = epoch,
      dose = c.dose[c.mode];
    chatSet({ running: true, generation: c.dir, error: "" });
    let result: {
      status: string;
      error?: string;
      direction?: string;
      tokens?: number;
      replies?: string[];
    };
    try {
      if (c.dir === "reads") {
        const r = await api(
          "/api/reads",
          { layer: f.layer, n: f.n, text: prompt, chat: true },
          { signal: ctl.signal },
        );
        if (current(e, f) && !ctl.signal.aborted) chatSet({ reads: r.units });
        result = {
          status: "completed",
          direction: "reads you",
          tokens: r.units.length,
        };
      } else {
        const turn: ChatTurn = {
          user: prompt,
          dose,
          mode: c.mode,
          replies: ["", "", ""],
          live: true,
        };
        let thread = [...c.thread, turn],
          ended = false;
        chatSet({ prompt: "", thread });
        const response = await fetch("/api/steer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctl.signal,
          body: JSON.stringify({
            layer: f.layer,
            n: f.n,
            prompt,
            dose,
            mode: c.mode,
            history: c.thread
              .filter((t) => !t.error)
              .map((t) => ({ user: t.user, replies: t.replies })),
          }),
        });
        await readSSE(response, (ev) => {
          if (ev.error) turn.error = ev.error;
          if (ev.row == null) ended = true;
          else turn.replies[ev.row] += ev.t || "";
          if (current(e, f))
            chatSet({
              thread: thread.map((t) =>
                t === turn ? { ...turn, replies: [...turn.replies] } : t,
              ),
            });
        });
        if (!ended && !turn.error)
          turn.error = "generation stream ended before completion";
        turn.live = false;
        if (current(e, f))
          chatSet({
            thread: thread.map((t) => (t === turn ? { ...turn } : t)),
            error: turn.error || "",
          });
        result = {
          status: turn.error ? "error" : "completed",
          replies: [...turn.replies],
          ...(turn.error ? { error: turn.error } : {}),
        };
      }
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      const cancelled = error.name === "AbortError",
        message = cancelled ? "generation cancelled" : error.message;
      if (current(e, f))
        chatSet({
          error: message,
          thread: get().chat.thread.map((t) =>
            t.live ? { ...t, live: false, error: message } : t,
          ),
        });
      result = { status: cancelled ? "cancelled" : "error", error: message };
    } finally {
      if (generation === ctl) {
        generation = null;
        if (current(e, f)) chatSet({ running: false, generation: null });
      }
    }
    return {
      ...result,
      prompt,
      layer: f.layer,
      n: f.n,
      dose,
      mode: c.mode,
      direction: c.dir === "reads" ? "reads you" : "writes",
    };
  }
  async function runLensSearch(query: string, request: number) {
    try {
      const result = await api(
        `/api/search?q=${encodeURIComponent(query)}&limit=400`,
      );
      if (request !== lensEpoch || disposed) return;
      set({ lensResults: result });
      if (get().analysisMode === "net") map?.setMarks(result.results || []);
    } catch (error) {
      if (request === lensEpoch && !disposed)
        set({
          lensResults: {
            ready: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
    }
  }

  async function analyzeText(text: string, reveal = true) {
    const query = text.trim(),
      request = ++queryEpoch;
    ++viewEpoch;
    set({ analysisText: text });
    if (reveal) actions.openTool("analyze");
    ++viewEpoch;
    tokenHover = null;
    if (get().analysisMode === "run") map?.setMarks([]);
    if (query.length < 2) {
      set({
        fireResults: null,
        inf: { ...get().inf, text: null, pos: -1, tokens: [], positions: [] },
        tokenWeights: [],
      });
      syncLeftMap();
      return;
    }
    set({ fireResults: { ready: false, loading: true, fires: true } });
    try {
      if (get().inf.text !== query) {
        const result = await api("/api/infer", { text: query });
        if (request !== queryEpoch || disposed) return;
        if (!result.ready) {
          set({ fireResults: { ready: false, fires: true } });
          return;
        }
        set({
          inf: {
            ...get().inf,
            text: query,
            pos: -1,
            tokens: result.tokens,
            positions: result.pos,
          },
        });
        safe(lightHeads());
        safe(tokenPaths(-1));
      }
      await inferView(request);
    } catch (error) {
      if (request === queryEpoch && !disposed)
        set({
          fireResults: {
            ready: false,
            fires: true,
            error: error instanceof Error ? error.message : String(error),
          },
        });
    }
  }

  // Separate operations and request generations: searching never overwrites an analysis draft
  // or cancels its response. Agent calls retain their existing lens/fires protocol aliases.
  function search(
    query: string,
    mode: "lens" | "fires" = "lens",
    manual = true,
  ) {
    if (mode === "fires") {
      safe(analyzeText(query, manual));
      return;
    }
    const request = ++lensEpoch;
    clearTimeout(queryTimer);
    set({
      lensQuery: query,
      lensResults:
        query.trim().length >= 2 ? { ready: false, loading: true } : null,
    });
    if (manual) actions.openTool("search");
    if (get().analysisMode === "net") map?.setMarks([]);
    if (query.trim().length >= 2)
      queryTimer = setTimeout(
        () => void runLensSearch(query.trim(), request),
        250,
      );
  }

  async function inferView(
    request = queryEpoch,
    pos = tokenHover ?? get().inf.pos,
  ) {
    const state = get(),
      view = ++viewEpoch;
    if (!state.inf.text) return;
    try {
      const result = await api(
        `/api/infer/view?${new URLSearchParams({ ...state.infFilters, pos: String(pos), sign: state.inf.sign, limit: "300" })}`,
      );
      if (view !== viewEpoch || request !== queryEpoch || disposed) return;
      const marks = [];
      if (result.map) {
        const bytes = atob(result.map),
          width = result.shape[1];
        for (let index = 0; index < bytes.length / 2; index++) {
          const half =
            bytes.charCodeAt(2 * index) |
            (bytes.charCodeAt(2 * index + 1) << 8);
          const sign = half & 0x8000 ? -1 : 1,
            exponent = (half >> 10) & 31,
            mantissa = half & 1023;
          const value =
            exponent === 0
              ? sign * mantissa * 2 ** -24
              : exponent === 31
                ? 0
                : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
          if (value)
            marks.push({
              layer: Math.floor(index / width),
              n: index % width,
              sign: value < 0 ? "-" : "+",
              w: Math.min(1, 0.25 + Math.abs(value) / 4),
            });
        }
      }
      if (get().analysisMode === "run")
        map?.setMarks(
          marks.length > 40000
            ? marks.sort((a, b) => b.w - a.w).slice(0, 40000)
            : marks,
        );
      set({ fireResults: { ...result, fires: true, ready: true } });
    } catch (error) {
      if (view === viewEpoch && request === queryEpoch && !disposed)
        set({
          fireResults: {
            ready: false,
            fires: true,
            error: error instanceof Error ? error.message : String(error),
          },
        });
    }
  }

  async function tokenPaths(pos: number) {
    if (pos < 0) {
      webKey = null;
      return refreshWeb();
    }
    if (get().analysisMode !== "run") return;
    const response = await fetch(
      `/api/infer/paths?pos=${pos}&min=${get().infFilters.min || 1}`,
    );
    if (!response.ok || (tokenHover ?? get().inf.pos) !== pos || disposed)
      return;
    const links = new Int16Array(await response.arrayBuffer());
    if ((tokenHover ?? get().inf.pos) !== pos) return;
    webKey = `tok/${pos}`;
    map?.setWeb(links);
  }
  async function lightHeads(pos = tokenHover ?? get().inf.pos) {
    const g = ++headEpoch,
      s = get(),
      f = s.focus,
      on = s.analysisMode === "run" && s.inf.text && pos >= 0;
    const r = on
      ? await api<{ layers?: number[][] }>(`/api/infer/heads?pos=${pos}`)
      : null;
    if (g !== headEpoch || disposed) return;
    if (r?.layers)
      map?.setHeadLevels(
        r.layers.map((row) => row.map((v) => Math.max(0, (v - 0.15) / 0.6))),
      );
    else if (f?.kind === "neuron" && s.nheads?.layers) {
      const levels = [];
      for (const [l, zs] of Object.entries(s.nheads.layers))
        levels[+l] = zs.map((z) => Math.max(0, Math.min(1, (z - 2.5) / 5)));
      map?.setHeadLevels(levels);
    } else map?.setHeadLevels(null);
    const shade = ++shadeEpoch,
      weights =
        on && f?.kind === "head"
          ? await api(`/api/head/row?layer=${f.layer}&head=${f.n}&pos=${pos}`)
          : null;
    if (shade === shadeEpoch && !disposed)
      set({ tokenWeights: weights?.units || [] });
  }
  function syncLeftMap() {
    const s = get();
    safe(lightHeads());
    if (s.analysisMode === "run" && s.inf.text) {
      safe(inferView());
      safe(tokenPaths(s.inf.pos));
    } else {
      map?.setMarks(
        s.analysisMode === "net" ? s.lensResults?.results || [] : [],
      );
      if (String(webKey).startsWith("tok/")) {
        webKey = null;
        safe(refreshWeb());
      }
    }
  }
  function pinToken(pos: number) {
    set((s) => ({ inf: { ...s.inf, pos: s.inf.pos === pos ? -1 : pos } }));
    tokenHover = null;
    syncLeftMap();
  }
  function previewToken(pos: number | null) {
    tokenHover = pos;
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(
      () => {
        safe(inferView());
        safe(tokenPaths(pos ?? get().inf.pos));
        safe(lightHeads());
      },
      pos == null ? 0 : 90,
    );
  }
  function filterInference(patch: Partial<ExplorerState["infFilters"]>) {
    set((s) => ({ infFilters: { ...s.infFilters, ...patch } }));
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => safe(inferView()), 200);
  }
  function clearAgentMarks() {
    map?.setNotes([]);
    if (agentMarked) {
      agentMarked = false;
      syncLeftMap();
    }
  }
  async function agentUi(event: UiEvent) {
    const e = event;
    if (e.action === "select" || e.action === "head") {
      await select(
        e.layer,
        e.action === "head" ? e.head : e.n,
        e.action === "head" ? "head" : "neuron",
        { agent: true, fly: false },
      );
      if (e.action === "select") map?.flyToNeuron(e.layer, e.n, 0.3);
    } else if (e.action === "highlight") {
      agentMarked = true;
      map?.setMarks(
        (e.neurons || []).map((x) => ({ ...x, sign: x.sign || "+", w: 1 })),
      );
    } else if (e.action === "rename") {
      set((s) => ({
        units: {
          ...s.units,
          [e.layer]: (s.units[e.layer] || []).map((u) =>
            u.n === e.n && u.kind === "neuron"
              ? { ...u, name: e.name.trim() }
              : u,
          ),
        },
        ...(s.focus?.layer === e.layer && s.focus?.n === e.n
          ? { name: e.name.trim() }
          : {}),
      }));
      if (get().units[e.layer]?.length)
        map?.setUnits(e.layer, get().units[e.layer]);
    } else if (e.action === "annotate") map?.setNotes(e.items || []);
    else if (e.action === "camera") {
      if (map?.layerMode !== null) map?.exitLayer();
      if (e.mode === "home") map?.home();
      else if (e.mode === "layer") map?.viewLayer(e.layer);
      else if (e.mode === "neuron")
        map?.flyToNeuron(e.layer, e.n, e.closeness || 0.22);
    } else if (e.action === "tab") {
      if (get().activePanel === "assistant") markFresh(e.tab);
      else setTab(e.tab);
    } else if (e.action === "search") search(e.query, "lens", false);
    else if (e.action === "text") {
      await analyzeText(e.text, false);
      if (get().inf.text !== e.text) return;
      const token = e.token,
        i = token ? get().inf.tokens.findIndex((t) => t.includes(token)) : -1;
      set((s) => ({
        inf: { ...s.inf, pos: i >= 0 ? s.inf.positions[i] : -1 },
      }));
      syncLeftMap();
    }
  }
  function uiState() {
    const s = get(),
      f = s.focus,
      c = s.chat;
    const layout = visiblePanels(
      s.assistantOpen,
      s.toolsOpen,
      s.activePanel,
      typeof matchMedia === "function" && matchMedia(COMPACT_WORKSPACE).matches,
    );
    return {
      browser_id: browserId,
      selected_neuron: f && f.kind !== "head" ? { ...f } : null,
      selected_head: f?.kind === "head" ? { layer: f.layer, head: f.n } : null,
      open_tab:
        layout.tools && s.workbenchTab === "inspect"
          ? s.selectionTab
          : layout.assistant
            ? "agent"
            : null,
      workspace: {
        assistant_visible: layout.assistant,
        tools_visible: layout.tools,
        tool: s.workbenchTab,
      },
      transitioning: selectionPending,
      chat: {
        dose: c.dose[c.mode],
        mode: c.mode,
        direction: c.dir === "reads" ? "reads you" : "writes",
        prompt: c.prompt,
        placeholder: c.dir === "reads" ? "text to read" : "Who are you?",
        running: Boolean(generation),
        generation: generation
          ? c.dir === "reads"
            ? "reads you"
            : "writes"
          : null,
        history_length: c.thread.length,
        last_error: c.error || null,
      },
    };
  }
  const controller = createChatUiController({
    arch,
    state: uiState,
    select: (layer: number, n: number) =>
      select(layer, n, "neuron", { agent: true, fly: false }),
    selectHead: (layer: number, n: number) =>
      select(layer, n, "head", { agent: true }),
    openTab: (tab: ExplorerState["tab"]) => {
      setTab(tab);
      if (get().tab !== tab)
        throw new Error("that tab is unavailable for the selected neuron");
    },
    controls,
    prompt: (prompt: string) => chatSet({ prompt }),
    submit: submitChat,
    cancel: cancelChat,
  });
  function restoreFocus() {
    const m = location.hash.match(/^#L(\d+)\/(N|h)(\d+)$/),
      f: Focus | null = m
        ? { layer: +m[1], n: +m[3], kind: m[2] === "h" ? "head" : "neuron" }
        : readStorage<Focus>(modelKey("explorer.focus"));
    if (!f || (get().focus && refLabel(get().focus) === refLabel(f))) return;
    if (f.kind === "head" ? validHead(f.layer, f.n) : validNeuron(f.layer, f.n))
      safe(select(f.layer, f.n, f.kind, { push: false }));
  }
  async function pollStatus() {
    try {
      const s = await api("/api/status");
      if (disposed) return;
      set({
        statusText: s.status,
        status: s.status === "ready" ? "" : s.status,
      });
      const pending = get().lensResults;
      if (
        s.status === "ready" &&
        pending?.ready === false &&
        !pending.loading &&
        !pending.error &&
        get().lensQuery.trim().length >= 2
      )
        void runLensSearch(get().lensQuery.trim(), ++lensEpoch);
      statusTimer = setTimeout(pollStatus, s.status === "ready" ? 8000 : 2000);
    } catch {
      if (!disposed) {
        set({ status: "server unreachable" });
        statusTimer = setTimeout(pollStatus, 2000);
      }
    }
  }
  function onHover(p: Pick | null, x = 0, y = 0) {
    if (get().analysisMode === "build") return;
    if (!p) {
      hoverKey = null;
      clearTimeout(hoverTimer);
      map?.setHoverConnections(null);
      set({ tooltip: null });
      return;
    }
    const key = `${p.type}/${p.layer}/${p.n ?? p.head ?? ""}`;
    const show = () => {
      if (hoverKey !== key || disposed) return;
      const s = get(),
        unit = s.units[p.layer]?.find(
          (u) => u.kind === "neuron" && u.n === p.n,
        ),
        data = hoverCache.get(key);
      set({ tooltip: { x, y, pick: p, unit, data } });
    };
    if (hoverKey === key) {
      show();
      return;
    }
    hoverKey = key;
    clearTimeout(hoverTimer);
    show();
    if (p.type === "block") return;
    hoverTimer = setTimeout(
      () =>
        safe(
          (async () => {
            if (!hoverCache.has(key))
              hoverCache.set(
                key,
                await api(
                  p.type === "head"
                    ? `/api/head?layer=${p.layer}&head=${p.head}`
                    : `/api/hover?layer=${p.layer}&n=${p.n}`,
                ),
              );
            if (hoverKey !== key) return;
            if (!["head", "neuron"].includes(get().focus?.kind || "")) {
              if (p.type === "head")
                map?.setHoverHead(
                  p.layer,
                  p.head,
                  headRoleLinks(hoverCache.get(key)),
                );
              else
                map?.setHoverConnections(
                  { layer: p.layer, n: p.n },
                  hoverCache.get(key)!.con,
                );
            }
            show();
          })(),
        ),
      120,
    );
  }
  const actions = {
    set,
    chatSet,
    safe,
    modelKey,
    browserId,
    validNeuron,
    validHead,
    controller,
    uiState,
    setTab,
    setView,
    setLayer,
    setLayout,
    select,
    closeFocus,
    rename,
    flushName,
    saveName,
    controls,
    applyDose,
    stepDose,
    submitChat,
    cancelChat,
    search,
    analyzeText,
    pinToken,
    previewToken,
    filterInference,
    agentUi,
    clearAgentMarks,
    goToNeuron(layer: number, n: number, kind: SelectionKind = "neuron") {
      safe(select(layer, n, kind, { fly: false }));
      if (kind === "neuron") map?.focusNeuron(layer, n);
    },
    openAssistant() {
      setTab("agent");
    },
    togglePanel(panel: "assistant" | "tools", visible: boolean) {
      set({
        [panel === "assistant" ? "assistantOpen" : "toolsOpen"]: !visible,
        activePanel: visible ? null : panel,
      });
    },
    openTool(workbenchTab: ExplorerState["workbenchTab"]): void {
      const mode =
        workbenchTab === "cache"
          ? "build"
          : workbenchTab === "analyze"
            ? "run"
            : workbenchTab === "search"
              ? "net"
              : get().analysisMode === "build"
                ? "net"
                : get().analysisMode;
      actions.setAnalysisMode(mode);
      set({ workbenchTab, toolsOpen: true, activePanel: "tools" });
    },
    setAnalysisMode(analysisMode: ExplorerState["analysisMode"]) {
      if (analysisMode === get().analysisMode) return;
      const wasBuild = get().analysisMode === "build";
      set({
        analysisMode,
        ...(analysisMode === "build"
          ? { view: "map" as const, tooltip: null }
          : {}),
      });
      if (analysisMode === "build") {
        webKey = null;
        hoverKey = null;
        clearTimeout(hoverTimer);
        map?.setMarks([]);
        map?.setWeb(null);
        map?.setConnections({ up: [], down: [] });
      } else {
        if (wasBuild) {
          map?.resetBuildProgress();
          if (get().units[get().layer]?.length)
            map?.setUnits(get().layer, get().units[get().layer]);
          if (get().con) map?.setConnections(get().con);
          webKey = null;
          safe(setLayout(get().layout));
        }
        syncLeftMap();
      }
    },
    paintBuild(
      counts: number[],
      active: { layer: number; start: number; end: number } | null,
    ) {
      if (get().analysisMode === "build") map?.setBuildProgress(counts, active);
    },
    layoutBuild(cells: Int16Array | null) {
      if (get().analysisMode === "build") map?.setLayout(cells);
    },
    edgesBuild(edges: Int16Array | null) {
      if (get().analysisMode === "build") map?.setWeb(edges);
    },
    setWeb(patch: { webOn?: boolean; webZ?: string }) {
      set(patch);
      webKey = null;
      if (get().analysisMode !== "build") safe(refreshWeb());
    },
    setSign(sign: ExplorerState["inf"]["sign"]) {
      set((s) => ({ inf: { ...s.inf, sign } }));
      safe(inferView());
    },
    color(colorBy: string) {
      set({ colorBy });
      scatter?.setColorBy(colorBy);
    },
    hoverNeuron(layer: number | null, n?: number) {
      map?.hover(layer, n);
    },
    hoverHead(layer: number | null, head?: number) {
      map?.hoverHead(layer, head);
    },
    resetView() {
      map?.exitLayer();
      map?.home();
    },
    exitLayer() {
      map?.exitLayer();
    },
    enterLayer(layer: number) {
      safe(setLayer(layer));
      map?.enterLayer(layer);
    },
    async attach({
      mapCanvas,
      labels,
      scatterCanvas,
      leftPanel,
      rightPanel,
    }: {
      mapCanvas: HTMLCanvasElement;
      labels: HTMLDivElement;
      scatterCanvas: HTMLCanvasElement;
      leftPanel: HTMLElement;
      rightPanel: HTMLElement;
    }) {
      disposed = false;
      const mounting = ++attachmentEpoch;
      const [{ createMap }, { createScatter }] = await Promise.all([
        import("../../explorer/static/map3d.js"),
        import("../../explorer/static/scatter.js"),
      ]);
      if (disposed || mounting !== attachmentEpoch) return;
      map = createMap(mapCanvas, labels, arch, {
        onPick: (l: number, n: number) => {
          if (get().analysisMode === "build") {
            map?.select(l, n, false);
            set({ layer: l, status: `L${l} N${n} · cache coverage` });
          } else safe(select(l, n, "neuron", { fly: false }));
        },
        onPickHead: (l: number, h: number) => {
          if (get().analysisMode !== "build") safe(select(l, h, "head"));
        },
        onPickLayer: (l: number) => safe(setLayer(l)),
        onLayerMode: (layerMode: number | null) => {
          set({ layerMode });
          if (layerMode !== null && layerMode !== get().layer)
            safe(setLayer(layerMode));
        },
        onHover,
      });
      scatter = createScatter(scatterCanvas, {
        onPick: (i: number) => {
          const d = scatter?.data;
          if (d?.kind[i] === "neuron") safe(select(d.layer, d.neuron[i]));
        },
        onHover: (i: number, x = 0, y = 0) => {
          if (i < 0 || !scatter?.data) {
            set({ tooltip: null });
            return;
          }
          const d = scatter.data,
            key = `rollout/${d.layer}/${d.row[i]}`;
          hoverKey = key;
          const show = () => {
            if (hoverKey === key && get().view === "embed")
              set({
                tooltip: {
                  x,
                  y,
                  rollout: { ...d, i, text: rolloutCache.get(key) || "…" },
                },
              });
          };
          show();
          if (!rolloutCache.has(key))
            safe(
              api(`/api/rollout?layer=${d.layer}&i=${d.row[i]}`).then((r) => {
                rolloutCache.set(key, r.text.slice(0, 500));
                show();
              }),
            );
        },
      });
      function insets() {
        // Docked sidebars already sit outside the canvas. Count only actual overlap.
        const scene = mapCanvas.getBoundingClientRect(),
          panels = [leftPanel, rightPanel].map((panel) =>
            panel.getBoundingClientRect(),
          );
        const left = Math.max(
          0,
          ...panels
            .filter((panel) => panel.width && panel.left <= scene.left)
            .map((panel) => panel.right - scene.left),
        );
        const right = Math.max(
          0,
          ...panels
            .filter((panel) => panel.width && panel.right >= scene.right)
            .map((panel) => scene.right - panel.left),
        );
        map?.setInsets(left, right);
        scatter?.setInsets(left, right);
      }
      observer = new ResizeObserver(insets);
      observer.observe(leftPanel);
      observer.observe(rightPanel);
      observer.observe(mapCanvas);
      observer.observe(document.documentElement);
      insets();
      bridge = connectUiBridge(browserId, controller);
      addEventListener("hashchange", restoreFocus);
      window.__ne = {
        map,
        scatter,
        browserId,
        get state() {
          return get();
        },
        controller,
      };
      set({ mapReady: true });
      safe(setLayout(get().layout));
      safe(pollStatus());
      await setLayer(get().layer);
      if (!disposed && get().analysisMode !== "build") restoreFocus();
    },
    dispose() {
      disposed = true;
      ++attachmentEpoch;
      ++epoch;
      ++lensEpoch;
      ++queryEpoch;
      ++viewEpoch;
      ++headEpoch;
      cancelChat();
      flushName();
      set({ mapReady: false });
      [
        queryTimer,
        filterTimer,
        nameTimer,
        statusTimer,
        hoverTimer,
        tokenTimer,
      ].forEach(clearTimeout);
      bridge?.close();
      observer?.disconnect();
      removeEventListener("hashchange", restoreFocus);
      map?.dispose();
      scatter?.dispose();
      if (window.__ne?.browserId === browserId) delete window.__ne;
    },
  };
  return { ...store, actions };
}
