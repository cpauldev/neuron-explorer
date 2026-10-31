import type { ThreadMessageLike } from "@assistant-ui/react";

export type HeadRole = "q" | "k" | "v" | "o";
export type SelectionKind = "neuron" | "head" | "random";
export type InspectorTab = "agent" | "chat" | "details" | "examples";
export type WorkbenchTab = "search" | "analyze" | "inspect" | "cache";
export type WorkspacePanel = "assistant" | "tools";
export interface Focus {
  layer: number;
  n: number;
  kind: SelectionKind;
}
export interface Architecture {
  n_layers: number;
  inter: number;
  hidden: number;
  layer_types: string[];
  attn_heads: number;
  kv_heads: number;
  linear_k_heads: number;
  linear_v_heads: number;
}
export interface ModelIndex {
  arch: Architecture;
  layers: Record<number, string>;
  model?: string;
  revision?: string | null;
  cache_key?: string;
  status?: string;
}
export interface Unit {
  kind: "neuron" | "random";
  n: number;
  z: number;
  words: string[];
  name: string;
}
export interface Token {
  tok: string;
  n?: number;
  w?: number;
}
export interface Lens {
  layer?: number;
  n?: number;
  up: string[];
  down: string[];
  steer_up?: string[];
  steer_down?: string[];
  kl_up?: number;
  kl_down?: number;
}
export interface Connection {
  layer: number;
  n: number;
  z: number;
  sign: number;
  lens: string[];
  lens_neg?: string[];
  logit?: string[];
  logit_neg?: string[];
  words?: string[];
  name?: string;
}
export interface HeadLink {
  layer: number;
  head: number;
  heads: number[];
  z: number;
  role?: HeadRole;
}
export interface HeadInfo {
  layer: number;
  head: number;
  full: boolean;
  src: string;
  q: Connection[];
  k: Connection[];
  reads: Connection[];
  writes: Connection[];
  q_toks: Token[];
  k_toks: Token[];
  read_toks: Token[];
  write_toks: Token[];
}
export interface NeuronHeads {
  layer: number;
  n: number;
  roles: Partial<Record<HeadRole, HeadLink[]>>;
  layers: Record<number, number[]>;
}
export interface WebSummary {
  layer: number;
  n: number;
  links: string | null;
  src: string;
  up: { neurons: number; fed_by: Token[]; held_by?: Token[] };
  down: { neurons: number; toward: Token[]; away: Token[] };
}
export interface Rollout {
  dose: number;
  rel_push: number;
  text: string;
  prompt: string;
  finish?: string;
}
export interface UnitDetails {
  name: string;
  rollouts?: Rollout[];
  baselines: Rollout[];
  prompts: Record<string, string>;
  rank?: number;
  n_ranked: number;
  stats?: {
    mass?: number;
    z: number;
    null_pct: number | null;
    words: [string, number, number][];
    per_prompt: Record<string, string[]>;
    dose: Record<
      string,
      { rel_push: number; distinct4: number; capped: number; logprob: number }
    >;
  };
}
export interface ResultRow {
  layer: number;
  n: number;
  sign: "+" | "-";
  score: number;
  rank: number;
  token?: string;
  name?: string;
  lens: string[];
  swept?: boolean;
}
export interface SearchResults {
  ready: boolean;
  loading?: boolean;
  fires?: boolean;
  error?: string;
  results?: ResultRow[];
  total?: number;
  tokens?: number;
}
export interface ChatTurn {
  user: string;
  dose: number;
  mode: "add" | "mul";
  replies: string[];
  live?: boolean;
  error?: string;
}
export interface Activation {
  act: number;
  text: string;
  pieces?: number[];
}
export interface LocalChatState {
  mode: "add" | "mul";
  dir: "writes" | "reads";
  dose: { add: number; mul: number };
  doseInput: string;
  prompt: string;
  running: boolean;
  generation: "writes" | "reads" | null;
  thread: ChatTurn[];
  reads: Activation[] | null;
  error: string;
}
export interface ChatControls {
  mode?: "add" | "mul";
  direction?: "writes" | "reads you";
  dose?: number;
}
export interface SelectionOptions {
  agent?: boolean;
  push?: boolean;
  fly?: boolean;
}
export interface NeuronName {
  layer: number;
  n: number;
  name: string;
}
export interface Embeddings {
  layer: number;
  x: number[];
  y: number[];
  kind: string[];
  neuron: number[];
  row: number[];
  prompt: string[];
  dose: number[];
}
export interface Pick {
  type: "neuron" | "head" | "block";
  layer: number;
  n: number;
  head: number;
  full?: boolean;
}
export interface HoverData {
  steer?: string[];
  steer_neg?: string[];
  lens: string[];
  lens_neg?: string[];
  con: { up: Connection[]; down: Connection[] };
  reads?: Connection[];
  writes?: Connection[];
}
export interface TooltipState {
  x: number;
  y: number;
  pick?: Pick;
  unit?: Unit;
  data?: HoverData & Partial<HeadInfo>;
  rollout?: Embeddings & { i: number; text: string };
}
export interface ExplorerState {
  index: ModelIndex;
  arch: Architecture;
  layer: number;
  units: Record<number, Unit[]>;
  focus: Focus | null;
  name: string;
  nameSaved: boolean;
  view: "map" | "embed";
  layout: string;
  layerMode: number | null;
  webOn: boolean;
  webZ: string;
  webSum: WebSummary | null;
  analysisMode: "net" | "run" | "build";
  mapReady: boolean;
  assistantOpen: boolean;
  toolsOpen: boolean;
  activePanel: WorkspacePanel | null;
  workbenchTab: WorkbenchTab;
  tab: InspectorTab;
  selectionTab: Exclude<InspectorTab, "agent">;
  fresh: Partial<Record<InspectorTab, boolean>>;
  lensQuery: string;
  analysisText: string;
  filter: string;
  showRandom: boolean;
  lensResults: SearchResults | null;
  fireResults: SearchResults | null;
  inf: {
    text: string | null;
    pos: number;
    sign: "both" | "+" | "-";
    tokens: string[];
    positions: number[];
  };
  infFilters: { lo: string; hi: string; min: string; q: string };
  tokenWeights: number[];
  unit: UnitDetails | null;
  lens: Lens | null;
  con: { up: Connection[]; down: Connection[] } | null;
  nheads: NeuronHeads | null;
  headInfo: HeadInfo | null;
  headCache: Record<string, HeadInfo>;
  loadError: string;
  lensError: string;
  conError: string;
  loading: boolean;
  embedLoading: boolean;
  embedAvailable: boolean;
  colorBy: string;
  statusText: string;
  status: string;
  tooltip: TooltipState | null;
  chat: LocalChatState;
}

export type Provider = "codex" | "claude";
export interface PendingFile {
  key?: string;
  name: string;
  id: string | null;
}
export interface ApprovalRequest {
  id: string;
  command: string;
  cwd?: string;
  state: "request" | "approved" | "denied" | "expired";
  submitting?: boolean;
  error?: string;
}
export interface SelectionContext {
  layer: number;
  n: number;
  kind: "neuron" | "head";
}
export interface MessageMetadata extends Record<string, unknown> {
  context?: SelectionContext;
  original?: string;
  shown?: string;
  files?: PendingFile[];
  approvals?: ApprovalRequest[];
  error?: string;
  stopped?: boolean;
}
export type MessagePart = Exclude<ThreadMessageLike["content"], string>[number];
export interface AssistantMessage extends Omit<
  ThreadMessageLike,
  "content" | "metadata" | "status"
> {
  id: string;
  content: MessagePart[];
  status?: ThreadMessageLike["status"];
  metadata: { custom: MessageMetadata };
}
type EventBase = { seq?: number };
export type JournalEvent = EventBase &
  (
    | {
        t: "user";
        context?: SelectionContext;
        text: string;
        shown?: string;
        attachments?: PendingFile[];
      }
    | { t: "text"; text: string }
    | {
        t: "tool";
        id?: string;
        name: string;
        input?: Extract<MessagePart, { type: "tool-call" }>["args"];
      }
    | { t: "tool_result"; id: string; output?: unknown; error?: boolean }
    | { t: "approval"; id: string; command: string; cwd?: string }
    | { t: "stopped" }
    | { t: "error"; error: string }
    | { t: "done"; status?: string }
    | { t: "chat"; chat: string }
    | ({ t: "ui" } & UiEvent)
  );
export type UiEvent =
  | { action: "head"; layer: number; head: number }
  | { action: "select"; layer: number; n: number }
  | {
      action: "highlight";
      neurons?: { layer: number; n: number; sign?: string }[];
    }
  | { action: "rename"; layer: number; n: number; name: string }
  | { action: "annotate"; items?: { layer: number; n: number; text: string }[] }
  | {
      action: "camera";
      mode: string;
      layer: number;
      n: number;
      closeness?: number;
    }
  | { action: "tab"; tab: InspectorTab }
  | { action: "search"; query: string }
  | { action: "text"; text: string; token?: string };
export interface SavedDraft {
  model?: string | null;
  version?: number;
  chat?: string;
  draft?: string;
  pending?: PendingFile[];
  html?: string;
}
export interface QueuedMessage {
  context?: SelectionContext;
  id: string;
  text: string;
  shown: string;
  atts: PendingFile[];
}
export interface PastChat {
  model?: string | null;
  chat: string;
  provider: Provider;
  title: string;
  updated: number;
  running?: boolean;
}
export interface AssistantState {
  provider: Provider;
  model: string | null;
  includeSelection: boolean;
  access: "project" | "home";
  chat: string | null;
  messages: AssistantMessage[];
  draft: string;
  pending: PendingFile[];
  queue: QueuedMessage[];
  busy: boolean;
  loading: boolean;
  connection: string;
  error: string;
  history: PastChat[];
  historyOpen: boolean;
  historyLoading: boolean;
  cursor: number;
  revision: number;
  suggestedName: (Focus & { name: string }) | null;
}
export interface AssistantHistory {
  model?: string | null;
  events: JournalEvent[];
  cursor: number;
  running: boolean;
  approvals: string[];
  history_error?: string;
  access?: AssistantState["access"];
}

export type ExplorerStore = ReturnType<
  typeof import("./explorer").createExplorer
>;
export type AssistantStore = ReturnType<
  typeof import("./assistant/store").createAssistant
>;
export type MapEngine = ReturnType<
  typeof import("../../explorer/static/map3d.js").createMap
>;
export type ScatterEngine = ReturnType<
  typeof import("../../explorer/static/scatter.js").createScatter
>;
declare global {
  interface Window {
    __ne?: {
      map: MapEngine;
      scatter: ScatterEngine;
      browserId: string;
      state: ExplorerState;
      controller: ReturnType<
        typeof import("../../explorer/static/chat_ui.js").createChatUiController
      >;
    };
  }
}
