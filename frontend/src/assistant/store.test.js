import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExplorer } from "../explorer";
import { createAssistant } from "./store";
import { deferred, indexFixture, json, mockApi } from "../test-helpers";

let explorer, assistant;
beforeEach(() => {
  localStorage.clear();
  mockApi();
  explorer = createExplorer(indexFixture);
  assistant = createAssistant(explorer);
});
afterEach(() => {
  assistant.actions.dispose();
  explorer.actions.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("provider-owned drafts, attachments and durable assistant streams", () => {
  it("does not overwrite a newer chat pointer when an untouched tab closes", () => {
    assistant.actions.start();
    localStorage.setItem(
      "explorer.agent.claude",
      JSON.stringify({ chat: "newer-chat", draft: "another tab" }),
    );
    assistant.actions.dispose();
    expect(JSON.parse(localStorage.getItem("explorer.agent.claude")).chat).toBe(
      "newer-chat",
    );
  });
  it("keeps provider drafts separate and persists structured data rather than HTML", async () => {
    assistant.actions.start();
    assistant.actions.draft("Claude draft");
    await assistant.actions.switchProvider("codex");
    expect(assistant.getSnapshot().draft).toBe("");
    assistant.actions.draft("Codex draft");
    await assistant.actions.switchProvider("claude");
    expect(assistant.getSnapshot().draft).toBe("Claude draft");
    expect(
      JSON.parse(localStorage.getItem("explorer.agent.codex")),
    ).toMatchObject({ version: 2, draft: "Codex draft" });
    expect(localStorage.getItem("explorer.agent.codex")).not.toContain("html");
  });
  it("restores history without repeating its map effects", async () => {
    localStorage.setItem(
      "explorer.agent.claude",
      JSON.stringify({ chat: "saved", draft: "retained" }),
    );
    const ui = vi.spyOn(explorer.actions, "agentUi");
    mockApi({
      "/api/agent/history": () =>
        json({
          events: [
            { seq: 1, t: "user", text: "hello" },
            { seq: 2, t: "ui", action: "select", layer: 7, n: 1 },
            { seq: 3, t: "text", text: "Saved answer" },
            { seq: 4, t: "done" },
          ],
          cursor: 4,
          running: false,
          approvals: [],
        }),
    });
    assistant.actions.start();
    await vi.waitFor(() => expect(assistant.getSnapshot().busy).toBe(false));
    expect(ui).not.toHaveBeenCalled();
    expect(assistant.getSnapshot().messages).toHaveLength(2);
    expect(assistant.getSnapshot().draft).toBe("retained");
  });
  it("does not remove another attachment when a removed upload fails", async () => {
    const pending = deferred();
    mockApi({ "/api/agent/upload": () => pending.promise });
    const upload = assistant.actions.attachFiles([new File(["a"], "bad.txt")]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const bad = assistant.getSnapshot().pending[0];
    assistant.actions.removeAttachment(bad.key);
    assistant.set((s) => ({
      pending: [...s.pending, { name: "keep.txt", id: "keep", key: "keep" }],
    }));
    pending.reject(new Error("failed"));
    await upload;
    expect(assistant.getSnapshot().pending.map((a) => a.id)).toEqual(["keep"]);
  });
  it("consumes journal events exactly once and attaches the selected neuron to sends", async () => {
    await explorer.actions.select(7, 1870);
    const fetcher = mockApi({
      "/api/agent/send": () => json({ chat: "live", cursor: 0 }),
      "/api/agent/events": () =>
        new Response(
          [
            { seq: 1, t: "user", text: "hello" },
            { seq: 2, t: "text", text: "Answer" },
            { seq: 3, t: "done" },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n") + "\n",
        ),
    });
    assistant.actions.send("hello");
    await vi.waitFor(() => expect(assistant.getSnapshot().busy).toBe(false));
    expect(assistant.getSnapshot().messages).toHaveLength(2);
    expect(assistant.getSnapshot().messages[1].content[0].text).toBe("Answer");
    const body = JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
    );
    expect(body).toMatchObject({
      layer: 7,
      n: 1870,
      browser: explorer.actions.browserId,
    });
  });
  it("blocks provider switching while working and expires approvals after interruption", async () => {
    const encoder = new TextEncoder();
    let streamController;
    mockApi({
      "/api/agent/send": () => json({ chat: "live", cursor: 0 }),
      "/api/agent/interrupt": () => json({ ok: true }),
      "/api/agent/events": (_, options) => {
        const stream = new ReadableStream({
          start(c) {
            streamController = c;
            c.enqueue(
              encoder.encode(
                '{"seq":1,"t":"user","text":"test"}\n{"seq":2,"t":"approval","id":"a","command":"test"}\n',
              ),
            );
          },
        });
        options.signal.addEventListener("abort", () =>
          streamController.error(new DOMException("Aborted", "AbortError")),
        );
        return new Response(stream);
      },
    });
    assistant.actions.send("test");
    await vi.waitFor(() =>
      expect(
        assistant.getSnapshot().messages.at(-1)?.metadata?.custom?.approvals,
      ).toHaveLength(1),
    );
    await assistant.actions.switchProvider("codex");
    expect(assistant.getSnapshot().provider).toBe("claude");
    await assistant.actions.stop();
    await vi.waitFor(() => expect(assistant.getSnapshot().busy).toBe(false));
    expect(
      assistant.getSnapshot().messages.at(-1).metadata.custom.approvals[0]
        .state,
    ).toBe("expired");
  });
});

it("keeps a queued message bound to the unit selected when it was queued", async () => {
  let release;
  let reads = 0;
  const fetcher = mockApi({
    "/api/agent/send": () => json({ chat: "queued-context", cursor: 0 }),
    "/api/agent/events": () =>
      ++reads === 1
        ? new Response(
            new ReadableStream({
              start(controller) {
                release = () => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ t: "done", seq: 1 }) + "\n",
                    ),
                  );
                  controller.close();
                };
              },
            }),
          )
        : new Response(JSON.stringify({ t: "done", seq: 2 }) + "\n"),
  });
  explorer.set({ focus: { layer: 16, n: 1, kind: "neuron" } });
  assistant.actions.send("First");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  explorer.set({ focus: { layer: 16, n: 2, kind: "neuron" } });
  assistant.actions.send("Next");
  explorer.set({ focus: { layer: 16, n: 3, kind: "neuron" } });
  release();
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/api/agent/send"),
    ).toHaveLength(2),
  );
  const body = JSON.parse(
    fetcher.mock.calls.filter(([url]) => url === "/api/agent/send")[1][1].body,
  );
  expect(body.n).toBe(2);
});
