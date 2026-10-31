import { vi } from "vitest";

export const architecture = {
  n_layers: 32,
  inter: 9216,
  hidden: 2560,
  attn_heads: 16,
  kv_heads: 4,
  linear_k_heads: 16,
  linear_v_heads: 32,
  layer_types: Array.from({ length: 32 }, (_, i) =>
    i % 4 === 3 ? "full_attention" : "linear_attention",
  ),
};
export const indexFixture = {
  arch: architecture,
  layers: {},
  cache_key: "",
  status: "ready",
};
export const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export function mockApi(overrides = {}) {
  const fetcher = vi.fn(async (url, options = {}) => {
    const parsed = new URL(url, "http://localhost"),
      path = parsed.pathname;
    if (overrides[path]) return overrides[path](parsed, options);
    const defaults = {
      "/api/index": indexFixture,
      "/api/status": { status: "ready" },
      "/api/layout": { available: false },
      "/api/unit": { name: "", rollouts: [] },
      "/api/lens": {
        up: ["hello"],
        down: ["bye"],
        steer_up: ["yes"],
        steer_down: ["no"],
        kl_up: 0.2,
        kl_down: 0.1,
      },
      "/api/connections": { up: [], down: [] },
      "/api/neuron/heads": { roles: {}, layers: {} },
      "/api/head": {
        q: [],
        k: [],
        reads: [],
        writes: [],
        q_toks: [],
        k_toks: [],
        read_toks: [],
        write_toks: [],
      },
      "/api/agent/models": { models: [{ id: "default", name: "CLI default" }] },
      "/api/agent/chats": { chats: [] },
      "/api/name": { ok: true },
      "/api/agent/approval": { ok: true },
    };
    if (path === "/api/web") return new Response(new ArrayBuffer(0));
    if (path === "/api/web/summary")
      return json({
        up: { neurons: 0, fed_by: [], held_by: [] },
        down: { neurons: 0, toward: [], away: [] },
      });
    if (Object.hasOwn(defaults, path)) return json(defaults[path]);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
