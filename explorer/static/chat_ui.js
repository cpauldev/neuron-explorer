// Explicit UI commands shared by the browser bridge and tests. No eval/script tool.
const COMMAND_FIELDS = {
  state: [], select: ["layer", "n"], head: ["layer", "head"], tab: ["tab"], chat_controls: ["dose", "mode", "direction"],
  chat_prompt: ["prompt"], chat_submit: ["timeout_seconds"],
};
export function parseDose(value) {
  const raw = String(value).trim().replace(/^[×x*]\s*/, "");
  if (!raw || !Number.isFinite(Number(raw))) throw new Error("dose must be a finite number");
  return Number(raw);
}

export function validateControls(patch) {
  if (!Object.keys(patch).length) throw new Error("provide at least one Chat control");
  for (const key of Object.keys(patch)) {
    if (!["dose", "mode", "direction"].includes(key)) throw new Error(`unknown Chat control: ${key}`);
  }
  if ("dose" in patch && (typeof patch.dose !== "number" || !Number.isFinite(patch.dose))) throw new Error("dose must be a finite number");
  if ("mode" in patch && !["add", "mul"].includes(patch.mode)) throw new Error("mode must be add or mul");
  if ("direction" in patch && !["writes", "reads you"].includes(patch.direction)) throw new Error("direction must be writes or reads you");
}

export function createChatUiController(handlers) {
  let changing = false, submission = null;
  const snapshot = () => handlers.state();
  return {
    cancel(id) { if (submission === id) handlers.cancel(); },
    async execute(command, id) {
      try {
        const { action, ...args } = command;
        if (!Object.hasOwn(COMMAND_FIELDS, action) || Object.keys(args).some(k => !COMMAND_FIELDS[action].includes(k))) throw new Error("invalid UI command arguments");
        if (action === "state") return { state: snapshot() };
        if (action === "chat_controls") validateControls(args);
        if (action === "chat_prompt" && typeof args.prompt !== "string") throw new Error("prompt must be a string");
        if (action === "select" && (!Number.isInteger(args.layer) || !Number.isInteger(args.n) || args.layer < 0 || args.layer >= handlers.arch.n_layers || args.n < 0 || args.n >= handlers.arch.inter)) throw new Error("neuron selection is out of range");
        if (action === "head") {
          const count = handlers.arch.layer_types?.[args.layer] === "full_attention" ? handlers.arch.attn_heads : handlers.arch.linear_v_heads;
          if (!Number.isInteger(args.layer) || args.layer < 0 || args.layer >= handlers.arch.n_layers || !Number.isInteger(args.head) || args.head < 0 || args.head >= count || !count) throw new Error("attention head selection is out of range");
        }
        if (action === "tab" && !["examples", "chat", "details"].includes(args.tab)) throw new Error("invalid neuron tab");
        const before = snapshot();
        if (changing || before.transitioning) throw new Error("neuron selection is still loading");
        if (submission || before.chat.running) throw new Error("Chat generation is already running; wait for it to finish");
        if (!["select", "head"].includes(action) && !before.selected_neuron && !before.selected_head) throw new Error("select a neuron first");
        if (action.startsWith("chat_") && before.selected_neuron?.kind !== "neuron") throw new Error("Chat requires a real neuron selection");
        if (action === "chat_submit") {
          if (before.open_tab !== "chat") throw new Error("open the neuron Chat tab before submitting");
          if (!before.chat.prompt.trim()) throw new Error("the visible Chat prompt is empty");
          submission = id;
          try {
            const result = await handlers.submit();
            return { state: snapshot(), submission: result, ...(result.error ? { error: result.error } : {}) };
          } finally { submission = null; }
        }
        changing = true;
        try {
          if (action === "select") {
            await handlers.select(args.layer, args.n);
            const selected = snapshot().selected_neuron;
            if (!selected || selected.layer !== args.layer || selected.n !== args.n || selected.kind !== "neuron") throw new Error("selection changed before the command completed");
          } else if (action === "head") {
            await handlers.selectHead(args.layer, args.head);
            const selected = snapshot().selected_head;
            if (!selected || selected.layer !== args.layer || selected.head !== args.head) throw new Error("selection changed before the command completed");
          } else if (action === "tab") handlers.openTab(args.tab);
          else if (action === "chat_controls") handlers.controls(args);
          else if (action === "chat_prompt") handlers.prompt(args.prompt);
          return { state: snapshot() };
        } finally { changing = false; }
      } catch (error) { return { error: String(error.message || error), state: snapshot() }; }
    },
  };
}

export function connectUiBridge(browser, controller) {
  const events = new EventSource(`/api/agent/ui/events?browser=${encodeURIComponent(browser)}`);
  const active = new Set();
  events.onmessage = async message => {
    const request = JSON.parse(message.data);
    if (request.cancel) { controller.cancel(request.cancel); return; }
    if (!request.id) return;
    active.add(request.id);
    let result;
    if (Date.now() >= request.expires_at) result = { error: "UI command expired before the browser could apply it" };
    else result = await controller.execute(request.command, request.id);
    active.delete(request.id);
    try {
      await fetch("/api/agent/ui/result", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browser, id: request.id, result }) });
    } catch { /* Server/disconnection errors are surfaced to the waiting tool. */ }
  };
  events.onerror = () => { for (const id of active) controller.cancel(id); };
  addEventListener("pagehide", () => { for (const id of active) controller.cancel(id); events.close(); }, { once: true });
  return events;
}
