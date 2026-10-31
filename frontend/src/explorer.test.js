import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExplorer } from "./explorer";
import { deferred, indexFixture, json, mockApi } from "./test-helpers";

let explorer;
beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  mockApi();
  explorer = createExplorer(indexFixture);
});
afterEach(() => {
  explorer.actions.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("React explorer actions and the acknowledged UI controller", () => {
  it("preserves manual controls, selection, negative/zero dose and neuron-specific history", async () => {
    const a = explorer.actions,
      command = (action, args = {}) =>
        a.controller.execute({ action, ...args }, crypto.randomUUID());
    expect((await command("chat_prompt", { prompt: "hello" })).error).toMatch(
      /select/,
    );
    await command("select", { layer: 7, n: 1870 });
    await command("tab", { tab: "chat" });
    await command("chat_controls", {
      dose: -0.8,
      mode: "add",
      direction: "writes",
    });
    await command("chat_prompt", { prompt: "First neuron draft" });
    a.chatSet({
      thread: [
        { user: "saved", dose: -0.8, mode: "add", replies: ["a", "b", "c"] },
      ],
    });
    await a.select(8, 12);
    await a.select(7, 1870);
    expect(explorer.getSnapshot().chat.prompt).toBe("First neuron draft");
    expect(explorer.getSnapshot().chat.thread).toHaveLength(1);
    expect((await command("chat_controls", { dose: 0 })).state.chat.dose).toBe(
      0,
    );
    const before = explorer.getSnapshot().chat;
    expect((await command("chat_controls", { dose: "invalid" })).error).toMatch(
      /finite/,
    );
    expect(explorer.getSnapshot().chat).toBe(before);
    expect(location.hash).toBe("#L7/N1870");
  });
  it("keeps inspector navigation stable and excludes head selections from neuron Chat", async () => {
    const a = explorer.actions;
    a.openAssistant();
    expect(explorer.getSnapshot().tab).toBe("agent");
    await a.select(7, 15, "head", { agent: true });
    expect(explorer.getSnapshot().tab).toBe("agent");
    a.setTab("chat");
    expect(explorer.getSnapshot().tab).toBe("agent");
    expect(
      (
        await a.controller.execute(
          { action: "chat_prompt", prompt: "no" },
          "head",
        )
      ).error,
    ).toMatch(/real neuron/);
    await expect(a.select(7, 16, "head")).rejects.toThrow(/range/);
    a.closeFocus();
    expect(explorer.getSnapshot().assistantOpen).toBe(true);
    expect(explorer.getSnapshot().focus).toBe(null);
  });
  it("does not treat a hidden experiment as open for an acknowledged submission", async () => {
    const a = explorer.actions;
    await a.select(7, 1870);
    a.setTab("chat");
    a.chatSet({ prompt: "Do not run while hidden." });
    a.togglePanel("tools", true);
    const hidden = await a.controller.execute(
      { action: "chat_submit" },
      "hidden-view",
    );
    expect(hidden.error).toMatch(/Experiment view/);
    expect(a.uiState().workspace.tools_visible).toBe(false);
    const opened = await a.controller.execute(
      { action: "tab", tab: "chat" },
      "visible-view",
    );
    expect(opened.state.open_tab).toBe("chat");
    expect(opened.state.workspace.tools_visible).toBe(true);
  });
  it("discards stale neuron fetches after a new selection", async () => {
    const first = deferred();
    mockApi({
      "/api/unit": (url) =>
        url.searchParams.get("n") === "1"
          ? first.promise
          : json({ name: "current" }),
    });
    const old = explorer.actions.select(7, 1);
    await explorer.actions.select(7, 2);
    first.resolve(json({ name: "stale" }));
    await old;
    expect(explorer.getSnapshot().name).toBe("current");
    expect(explorer.getSnapshot().focus.n).toBe(2);
  });
  it("streams all three dose rows and reports genuine completion through MCP", async () => {
    mockApi({
      "/api/steer": () =>
        Promise.resolve(
          new Response(
            'data: {"row":0,"t":"positive"}\n\ndata: {"row":1,"t":"base"}\n\ndata: {"row":2,"t":"negative"}\n\ndata: {}\n\n',
          ),
        ),
    });
    const a = explorer.actions;
    await a.select(7, 1870);
    a.setTab("chat");
    a.chatSet({ prompt: "test" });
    const result = await a.controller.execute({ action: "chat_submit" }, "run");
    expect(result.submission.status).toBe("completed");
    expect(result.submission.replies).toEqual(["positive", "base", "negative"]);
    expect(result.state.chat.running).toBe(false);
    expect(result.state.chat.history_length).toBe(1);
  });
  it("invalidates a pending search immediately when the query changes", async () => {
    vi.useFakeTimers();
    const first = deferred();
    mockApi({ "/api/search": () => first.promise });
    explorer.actions.search("first");
    await vi.advanceTimersByTimeAsync(250);
    explorer.actions.search("second");
    first.resolve(json({ ready: true, results: [{ n: 1 }] }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(explorer.getSnapshot().lensResults?.results).toBe(undefined);
  });
  it("keeps search and text analysis independent even when their requests overlap", async () => {
    vi.useFakeTimers();
    const inference = deferred();
    mockApi({
      "/api/infer": () => inference.promise,
      "/api/infer/view": () =>
        json({
          ready: true,
          total: 1,
          results: [
            { layer: 7, n: 3, sign: "+", score: 1.2, lens: ["passage"] },
          ],
        }),
      "/api/search": () =>
        json({
          ready: true,
          total: 1,
          results: [{ layer: 7, n: 8, sign: "+", rank: 0, lens: ["concept"] }],
        }),
    });
    const analysis = explorer.actions.analyzeText("A passage to analyze.");
    explorer.actions.search("concept");
    await vi.advanceTimersByTimeAsync(250);
    inference.resolve(
      json({ ready: true, tokens: ["A", " passage"], pos: [0, 1] }),
    );
    await analysis;
    expect(explorer.getSnapshot()).toMatchObject({
      lensQuery: "concept",
      analysisText: "A passage to analyze.",
      lensResults: { results: [{ n: 8 }] },
      fireResults: { results: [{ n: 3 }] },
    });
    explorer.actions.search("");
    expect(explorer.getSnapshot().inf.text).toBe("A passage to analyze.");
    expect(explorer.getSnapshot().fireResults.results[0].n).toBe(3);
  });
  it("allows navigation while a search is pending without running the analysis draft", async () => {
    vi.useFakeTimers();
    const fetcher = mockApi({
      "/api/search": () => json({ ready: true, total: 0, results: [] }),
    });
    explorer.set({ analysisText: "Do not run me yet." });
    explorer.actions.search("a concept");
    explorer.actions.openTool("analyze");
    await vi.advanceTimersByTimeAsync(300);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).startsWith("/api/search?"),
      ),
    ).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url === "/api/infer")).toBe(
      false,
    );
    expect(explorer.getSnapshot().lensResults.ready).toBe(true);
    expect(explorer.getSnapshot().analysisText).toBe("Do not run me yet.");
  });
  it("keeps interrupted partial replies settled when returning to a neuron", async () => {
    let started = false;
    mockApi({
      "/api/steer": (_, options) => {
        let sink;
        const body = new ReadableStream({
          start(controller) {
            sink = controller;
            controller.enqueue(
              new TextEncoder().encode('data: {"row":0,"t":"partial"}\n\n'),
            );
            started = true;
          },
        });
        options.signal.addEventListener("abort", () =>
          sink.error(new DOMException("Aborted", "AbortError")),
        );
        return new Response(body);
      },
    });
    await explorer.actions.select(7, 1);
    explorer.actions.chatSet({ prompt: "hello" });
    const pending = explorer.actions.submitChat();
    await vi.waitFor(() => {
      expect(started).toBe(true);
      expect(explorer.getSnapshot().chat.thread[0]?.replies[0]).toBe("partial");
    });
    await explorer.actions.select(7, 2);
    await pending;
    await explorer.actions.select(7, 1);
    expect(explorer.getSnapshot().chat.running).toBe(false);
    expect(explorer.getSnapshot().chat.thread[0]).toMatchObject({
      live: false,
      error: "generation cancelled",
      replies: ["partial", "", ""],
    });
  });
});
