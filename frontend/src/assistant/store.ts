import type {
  ExplorerStore,
  AssistantState,
  AssistantMessage,
  ApprovalRequest,
  SavedDraft,
  JournalEvent,
  AssistantHistory,
  PendingFile,
  Provider,
  SelectionContext,
} from "../types";
import { api, createStore, readStorage, writeStorage } from "../lib/store";
import { followAssistant } from "../../../explorer/static/assistant_stream.js";
import { appendEvent, replayEvents } from "./journal";

export function createAssistant(explorer: ExplorerStore) {
  const savedProvider =
    readStorage("explorer.agent.provider") ||
    (() => {
      try {
        return localStorage.getItem("explorer.agent.provider");
      } catch {
        return null;
      }
    })();
  const provider: Provider =
    savedProvider === "codex" || savedProvider === "claude"
      ? savedProvider
      : (() => {
          try {
            return localStorage.getItem("explorer.agent.codex") &&
              !localStorage.getItem("explorer.agent")
              ? "codex"
              : "claude";
          } catch {
            return "claude";
          }
        })();
  const savedAccess =
    readStorage("explorer.agent.access") ||
    (() => {
      try {
        return localStorage.getItem("explorer.agent.access");
      } catch {
        return null;
      }
    })();
  const store = createStore<AssistantState>({
    provider,
    model: null,
    includeSelection: readStorage("explorer.agent.includeSelection") !== false,
    access: savedAccess === "home" ? "home" : "project",
    chat: null,
    messages: [],
    draft: "",
    pending: [],
    queue: [],
    busy: false,
    loading: false,
    connection: "",
    error: "",
    history: [],
    historyOpen: false,
    historyLoading: false,
    cursor: 0,
    revision: 0,
    suggestedName: null,
  });
  const get = store.getSnapshot,
    set = store.set;
  let ctl: AbortController | null = null,
    finished = Promise.resolve(),
    starting: Promise<{ chat: string; cursor: number }> | null = null,
    disposed = false,
    flushTimer: ReturnType<typeof setTimeout> | undefined,
    resumeAfter: SavedDraft | null = null;
  const key = () =>
    explorer.actions.modelKey(`explorer.agent.${get().provider}`);
  const safe = (promise: unknown) =>
    Promise.resolve(promise).catch(
      (error) => !disposed && set({ error: error.message }),
    );
  const settle = (messages: AssistantMessage[]): AssistantMessage[] =>
    messages.map((m) =>
      m.role !== "assistant"
        ? m
        : {
            ...m,
            ...(m.status?.type === "running"
              ? { status: { type: "incomplete", reason: "cancelled" } }
              : {}),
            metadata: {
              custom: {
                ...m.metadata.custom,
                approvals: (m.metadata.custom.approvals || []).map((a) =>
                  a.state === "request" ? { ...a, state: "expired" } : a,
                ),
              },
            },
          },
    );
  function save() {
    const s = get();
    writeStorage(key(), {
      version: 2,
      chat: s.chat,
      model: s.model,
      draft: s.draft,
      pending: s.pending.filter((a) => a.id),
    });
    writeStorage("explorer.agent.provider", s.provider);
    writeStorage("explorer.agent.access", s.access);
    if (s.chat)
      writeStorage(`explorer.draft.${s.chat}`, {
        model: s.model,
        draft: s.draft,
        pending: s.pending.filter((a) => a.id),
      });
  }
  function load() {
    let old = readStorage<SavedDraft>(key());
    if (
      !old &&
      get().provider === "claude" &&
      !explorer.getSnapshot().index.cache_key
    )
      old = readStorage<SavedDraft>("explorer.agent");
    set({
      chat: old?.chat || null,
      model: old?.model || null,
      draft: old?.draft || "",
      pending: old?.pending?.filter((a) => a.id) || [],
      messages: [],
      queue: [],
      cursor: 0,
      error: "",
      suggestedName: null,
      connection: "",
      revision: get().revision + 1,
    });
    return old;
  }
  function apply(event: JournalEvent, controller?: AbortController) {
    if (controller && ctl !== controller) return;
    if (event.seq != null && event.seq <= get().cursor) return;
    set((s) => ({
      messages: appendEvent(s.messages, event, s.chat || "new"),
      cursor: event.seq ?? s.cursor,
      connection: "",
    }));
    if (event.t === "ui") safe(explorer.actions.agentUi(event));
    if (event.t === "chat" && event.chat) {
      set({ chat: event.chat });
      save();
    }
  }
  function fail(error: Error, controller: AbortController) {
    if (ctl !== controller || disposed || error.name === "AbortError") return;
    set({
      error: error.message,
      messages: appendEvent(
        get().messages,
        { t: "error", error: error.message },
        get().chat || "new",
      ),
    });
  }
  async function follow(
    chat: string,
    cursor: number,
    controller: AbortController,
  ) {
    await followAssistant(
      chat,
      cursor,
      (event: JournalEvent) => apply(event, controller),
      controller.signal,
      async (...args: Parameters<typeof fetch>) => {
        try {
          return await fetch(...args);
        } catch (caught) {
          const error =
            caught instanceof Error ? caught : new Error(String(caught));
          if (!controller.signal.aborted && ctl === controller)
            set({
              connection: "Reconnecting… The reply continues on the server.",
            });
          throw error;
        }
      },
      async (ms) => {
        if (ctl === controller && !controller.signal.aborted)
          set({
            connection: "Reconnecting… The reply continues on the server.",
          });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      },
    );
  }
  async function resume(old: SavedDraft | null = null) {
    if (!get().chat || ctl) return;
    const controller = (ctl = new AbortController()),
      chat = get().chat!;
    let finish!: () => void;
    finished = new Promise((resolve) => {
      finish = resolve;
    });
    set({ busy: true, loading: true, error: "" });
    try {
      let history = await api<AssistantHistory>(
        `/api/agent/history?chat=${encodeURIComponent(chat)}`,
        undefined,
        { signal: controller.signal },
      );
      // One-time migration from the old browser HTML cache. Only extracted text
      // goes to the import endpoint; no cached markup is ever mounted in React.
      if (!history.events.length && old?.html) {
        const doc = new DOMParser().parseFromString(old.html, "text/html");
        const messages = [...doc.body.children].flatMap((element) => {
          const el = element as HTMLElement;
          if (el.classList.contains("user"))
            return [{ t: "user", text: el.dataset.msg || el.textContent }];
          if (el.classList.contains("assistant")) {
            el.querySelectorAll(".a-ctl,.a-busy").forEach((e) => e.remove());
            return el.textContent.trim()
              ? [{ t: "text", text: el.textContent }]
              : [];
          }
          return [];
        });
        if (messages.length) {
          await api(
            "/api/agent/history/import",
            { chat, messages },
            { signal: controller.signal },
          );
          history = await api<AssistantHistory>(
            `/api/agent/history?chat=${encodeURIComponent(chat)}`,
            undefined,
            { signal: controller.signal },
          );
        }
      }
      if (ctl !== controller || disposed) return;
      set({
        ...(!old || !("model" in old) ? { model: history.model || null } : {}),
        messages: replayEvents(
          history.events,
          chat,
          history.running ? history.approvals : [],
        ),
        cursor: history.cursor,
        loading: false,
        connection: "",
        error: history.history_error || "",
      });
      if (history.running) await follow(chat, history.cursor, controller);
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      fail(error, controller);
    } finally {
      if (ctl === controller) {
        ctl = null;
        set((s) => ({
          busy: false,
          loading: false,
          messages: settle(s.messages),
        }));
        save();
        if (!disposed && get().queue.length) {
          clearTimeout(flushTimer);
          flushTimer = setTimeout(flushQueue, 0);
        }
      }
      finish();
    }
  }
  async function turn(
    text: string,
    shown = text,
    atts: PendingFile[] = [],
    context?: SelectionContext,
  ) {
    if (ctl || disposed) return;
    const controller = (ctl = new AbortController()),
      f = context;
    let finish!: () => void;
    finished = new Promise((resolve) => {
      finish = resolve;
    });
    const before = get().messages;
    const optimistic: JournalEvent = {
      context,
      t: "user",
      text,
      shown,
      attachments: atts,
    };
    set({
      busy: true,
      error: "",
      suggestedName: null,
      messages: appendEvent(before, optimistic, get().chat || "new"),
    });
    explorer.actions.clearAgentMarks();
    try {
      const s = get(),
        body = {
          browser: explorer.actions.browserId,
          provider: s.provider,
          model: s.model,
          access: s.access,
          chat: s.chat,
          message: text,
          shown,
          attachments: atts.map((a) => a.id),
          attachment_names: atts.map((a) => a.name),
          ...(context
            ? {
                layer: context.layer,
                ...(context.kind === "head"
                  ? { head: context.n }
                  : { n: context.n }),
              }
            : {}),
        };
      starting = api("/api/agent/send", body, { signal: controller.signal });
      let started;
      try {
        started = await starting;
      } finally {
        starting = null;
      }
      if (ctl !== controller) return;
      // Replace the optimistic user message with the journal's canonical one.
      set({ chat: started.chat, cursor: started.cursor, messages: before });
      save();
      await follow(started.chat, started.cursor, controller);
      const answer =
        get()
          .messages.filter((m) => m.role === "assistant")
          .at(-1)
          ?.content.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") || "";
      const name = answer
        .match(/\*\*Name\*\*:?\s*(.+)/)?.[1]
        .replace(/[*`]/g, "")
        .trim();
      if (name && f?.kind === "neuron" && text.startsWith("Explain "))
        set({ suggestedName: { ...f, name } });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      fail(error, controller);
    } finally {
      if (ctl === controller) {
        ctl = null;
        resumeAfter = null;
        set((s) => ({ busy: false, messages: settle(s.messages) }));
        save();
        if (!disposed && get().queue.length) {
          clearTimeout(flushTimer);
          flushTimer = setTimeout(flushQueue, 0);
        }
      }
      finish();
    }
  }
  async function stop() {
    const controller = ctl;
    if (!controller) return;
    if (starting) {
      try {
        await starting;
      } catch {
        return;
      }
    }
    if (ctl !== controller) return;
    try {
      if (get().chat) await api("/api/agent/interrupt", { chat: get().chat });
      controller.abort();
      if (ctl === controller)
        set((s) => ({
          messages: appendEvent(s.messages, { t: "stopped" }, s.chat || "new"),
        }));
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      if (ctl === controller) set({ error: error.message });
      throw error;
    }
  }
  function send(
    text = get().draft,
    shown = text,
    atts = get().pending,
    contextOverride?: SelectionContext | null,
  ) {
    const focus = explorer.getSnapshot().focus;
    const selected =
      get().includeSelection &&
      focus &&
      (focus.kind === "neuron" || focus.kind === "head")
        ? { layer: focus.layer, n: focus.n, kind: focus.kind }
        : undefined;
    const context =
      contextOverride === undefined ? selected : contextOverride || undefined;
    if (get().pending.some((a) => !a.id) || (!text.trim() && !atts.length))
      return false;
    text = text.trim() || "(see the attached files)";
    shown = shown.trim() || "(attached files)";
    set({ draft: "", pending: [] });
    save();
    if (ctl) {
      set((s) => ({
        queue: [
          ...s.queue,
          { id: crypto.randomUUID(), text, shown, atts, context },
        ],
      }));
    } else safe(turn(text, shown, atts, context));
    return true;
  }
  function flushQueue() {
    if (ctl || !get().queue.length || disposed) return;
    const [next, ...rest] = get().queue;
    set({ queue: rest });
    safe(turn(next.text, next.shown, next.atts, next.context));
  }
  async function interruptQueue() {
    const pending = finished;
    await stop();
    await pending;
    if (finished === pending && !ctl) flushQueue();
  }
  async function rewind(act: "edit" | "reroll") {
    if (ctl) return;
    const messages = get().messages,
      i = messages.findLastIndex((m) => m.role === "user");
    if (i < 0) return;
    const meta = messages[i].metadata.custom,
      atts = meta.files || [],
      s = get(),
      revision = s.revision;
    set({ busy: true, error: "" });
    try {
      if (s.chat)
        await api("/api/agent/rewind", {
          provider: s.provider,
          chat: s.chat,
          text: meta.original,
        });
      if (disposed || get().revision !== revision || get().chat !== s.chat)
        return;
      set({ messages: messages.slice(0, i), busy: false });
      // Rewind truncates journal sequence numbers; reset the cursor from history
      // before a subsequent stream starts.
      if (act === "reroll")
        await turn(meta.original || "", meta.shown, atts, meta.context);
      else {
        set({
          draft: meta.shown || meta.original || "",
          pending: atts,
          revision: s.revision + 1,
        });
        save();
      }
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      if (!disposed && get().revision === revision)
        set({ busy: false, error: error.message });
    }
  }
  async function approve(id: string, allow: boolean) {
    const chat = get().chat;
    const patch = (values: Partial<ApprovalRequest>) =>
      set((s) => ({
        messages: s.messages.map((m) =>
          m.role !== "assistant"
            ? m
            : {
                ...m,
                metadata: {
                  custom: {
                    ...m.metadata.custom,
                    approvals: (m.metadata.custom.approvals || []).map((a) =>
                      a.id === id ? { ...a, ...values } : a,
                    ),
                  },
                },
              },
        ),
      }));
    patch({ submitting: true, error: "" });
    try {
      await api("/api/agent/approval", { chat, id, allow });
      if (get().chat === chat)
        patch({ state: allow ? "approved" : "denied", submitting: false });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      if (get().chat === chat)
        patch({
          submitting: false,
          error: error.message,
          ...(error.message.includes("409") ? { state: "expired" } : {}),
        });
    }
  }
  async function attachFiles(files: File[]) {
    const revision = get().revision;
    for (const file of files) {
      if (revision !== get().revision || disposed) break;
      const a: PendingFile = {
        key: crypto.randomUUID(),
        name: file.name || "pasted",
        id: null,
      };
      set((s) => ({ pending: [...s.pending, a] }));
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = () => reject(new Error("Could not read this file."));
          reader.readAsDataURL(file);
        });
        const result = await api("/api/agent/upload", {
          name: a.name,
          type: file.type,
          data,
        });
        if (revision === get().revision && !disposed)
          set((s) => ({
            pending: s.pending.map((p) =>
              p.key === a.key ? { ...p, id: result.id } : p,
            ),
          }));
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        if (revision === get().revision && !disposed)
          set((s) => ({
            pending: s.pending.filter((p) => p.key !== a.key),
            error: `${a.name}: ${error.message}`,
          }));
      }
      if (revision === get().revision) save();
    }
  }
  async function historyToggle() {
    const open = !get().historyOpen;
    set({ historyOpen: open });
    if (!open) return;
    set({ historyLoading: true });
    try {
      const { chats } = await api("/api/agent/chats");
      if (!disposed) set({ history: chats, historyLoading: false });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      if (!disposed) set({ historyLoading: false, error: error.message });
    }
  }
  async function openHistory(chat: string, provider: Provider) {
    if (get().busy || get().pending.some((a) => !a.id)) return;
    save();
    set({ provider });
    load();
    const draft = readStorage<SavedDraft>(`explorer.draft.${chat}`, {})!;
    set({
      chat,
      model: draft.model || null,
      draft: draft.draft || "",
      pending: draft.pending || [],
      historyOpen: false,
    });
    save();
    explorer.actions.clearAgentMarks();
    await resume(draft);
  }
  const actions = {
    safe,
    send,
    stop,
    rewind,
    approve,
    async retryLatest() {
      if (get().busy) return;
      const user = get().messages.findLast((m) => m.role === "user");
      if (!user) {
        if (get().chat) await resume();
        return;
      }
      if (get().chat) await rewind("reroll");
      else {
        const meta = user.metadata.custom;
        send(
          meta.original || meta.shown || "",
          meta.shown,
          meta.files || [],
          meta.context || null,
        );
      }
    },
    attachFiles,
    historyToggle,
    openHistory,
    interruptQueue,
    draft(draft: string) {
      set({ draft });
      save();
    },
    removeAttachment(key: string | null | undefined) {
      set((s) => ({
        pending: s.pending.filter((p) => (p.key || p.id) !== key),
      }));
      save();
    },
    dropQueue(id: string) {
      set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    },
    async switchProvider(provider: Provider) {
      if (get().busy || get().pending.some((a) => !a.id)) return;
      save();
      set({ provider });
      const old = load();
      save();
      await resume(old);
    },
    model(model: string | null) {
      if (!get().busy) {
        set({ model });
        save();
      }
    },
    includeSelection(includeSelection: boolean) {
      set({ includeSelection });
      writeStorage("explorer.agent.includeSelection", includeSelection);
    },
    access(access: AssistantState["access"]) {
      if (!get().busy) {
        set({ access });
        save();
      }
    },
    async newChat() {
      clearTimeout(flushTimer);
      set({ queue: [] });
      await stop();
      await finished;
      set({
        chat: null,
        messages: [],
        draft: "",
        pending: [],
        cursor: 0,
        busy: false,
        loading: false,
        revision: get().revision + 1,
        error: "",
        connection: "",
        historyOpen: false,
        suggestedName: null,
      });
      save();
      explorer.actions.clearAgentMarks();
    },
    explain() {
      const f = explorer.getSnapshot().focus;
      if (!f || !["head", "neuron"].includes(f.kind) || get().busy) return;
      const id = `L${f.layer} ${f.kind === "head" ? "h" : "N"}${f.n}`;
      send(
        f.kind === "head"
          ? `Explain attention head ${id}: report its q/k/v/o roles and verify its attention on contrasting texts.`
          : `Explain ${id}: write the autointerp report.`,
        `explain ${id}`,
        [],
      );
    },
    explainWeb() {
      const f = explorer.getSnapshot().focus;
      if (f?.kind !== "neuron" || get().busy) return;
      send(
        `Look at the cone of L${f.layer} N${f.n} (what it reads from and writes into, a few hops out) and tell me briefly what that circuit seems to do. Highlight the neurons you mention.`,
        `what does the web of L${f.layer} N${f.n} do?`,
        [],
      );
    },
    useName() {
      const p = get().suggestedName;
      if (!p) return;
      safe(explorer.actions.saveName({ layer: p.layer, n: p.n, name: p.name }));
      const f = explorer.getSnapshot().focus;
      if (f?.layer === p.layer && f?.n === p.n && f.kind === "neuron")
        explorer.actions.rename(p.name);
      set({ suggestedName: null });
    },
    start() {
      disposed = false;
      const old = load();
      resumeAfter = old;
      if (get().chat) safe(resume(old));
    },
    reconnect() {
      if (!ctl) safe(resume(resumeAfter));
    },
    dispose() {
      disposed = true;
      clearTimeout(flushTimer);
      ctl?.abort();
      ctl = null;
    },
  };
  return { ...store, actions };
}
