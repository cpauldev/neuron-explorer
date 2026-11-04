import React from "react";
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi, json } from "../test-helpers";
import { Details, SelectionPanel } from "./Inspector";
import { SearchPanel, ActivationPanel, ResultRows } from "./Analysis";
import { CanvasControls } from "./CanvasControls";
import { Viewport } from "./Viewport";
import { AssistantSidebar } from "./AssistantSidebar";
import { ExplorerTools } from "./ExplorerTools";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { Tabs, TabsContent } from "./ui/tabs";
import { explorer, assistant, wrap } from "./ui-test-helpers";

it("delays static overview loading feedback and restarts the delay for a new selection", () => {
  vi.useFakeTimers();
  try {
    explorer.set({
      focus: { kind: "neuron", layer: 20, n: 7333 },
      loading: true,
    });
    const { container } = wrap(<Details />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      container.querySelector('[data-slot="generation-loader"]'),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("status").textContent).toBe(
      "Loading neuron details…",
    );
    act(() => explorer.set({ focus: { kind: "neuron", layer: 20, n: 7334 } }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() =>
      explorer.set({ loading: false, loadError: "Network unavailable" }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Network unavailable",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("explains model-wide missing embeddings and offers a return to the map", () => {
  explorer.set({ view: "embed", embedLoading: false, embedAvailable: false });
  wrap(
    <Tabs value="embed">
      <Viewport
        mapRef={React.createRef()}
        labelsRef={React.createRef()}
        scatterRef={React.createRef()}
      />
    </Tabs>,
  );
  expect(
    screen.getByText("No saved rollout embeddings for this model."),
  ).toBeTruthy();
  expect(screen.queryByText(/Choose a layer with saved examples/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to map" }));
  expect(explorer.getSnapshot().view).toBe("map");
});

it("explains absent model caches instead of displaying the runtime ready status", () => {
  explorer.set({ statusText: "ready" });
  wrap(
    <ResultRows
      id="test-results"
      results={{
        ready: false,
        message: "Activation calibration has not been built for this model.",
      }}
    />,
  );
  expect(
    screen.getByText(
      "Activation calibration has not been built for this model.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("ready")).toBeNull();
});

it("shows the shared announced loader until search results arrive", () => {
  explorer.set({
    lensQuery: "method",
    lensResults: { ready: false, loading: true },
  });
  const { container } = wrap(<SearchPanel />);
  expect(screen.getByRole("status").textContent).toContain("Searching…");
  expect(
    container.querySelector('[data-slot="generation-loader"]'),
  ).toBeTruthy();
  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  act(() =>
    explorer.set({ lensResults: { ready: true, results: [], total: 0 } }),
  );
  expect(screen.queryByText("Searching…")).toBeNull();
  expect(container.querySelector('[data-slot="generation-loader"]')).toBeNull();
});

it("does not offer browsing saved examples when the model has none", () => {
  wrap(<SearchPanel />);
  expect(
    screen.queryByRole("combobox", { name: "Browse saved examples" }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Search token associations or select a neuron on the map.",
    ),
  ).toBeTruthy();
});

it("only asks users to select a token after analysis has produced tokens", () => {
  wrap(<ActivationPanel />);
  expect(
    screen.queryByText("Select a token to inspect its activity."),
  ).toBeNull();
  act(() =>
    explorer.set({
      inf: {
        ...explorer.getSnapshot().inf,
        tokens: ["example"],
        positions: [0],
      },
    }),
  );
  expect(
    screen.getByText("Select a token to inspect its activity."),
  ).toBeTruthy();
});

it("clears the current selection from the map toolbar", () => {
  wrap(
    <Tabs value="map">
      <CanvasControls />
    </Tabs>,
  );
  expect(screen.queryByRole("button", { name: /Clear selection/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Reset view" })).toBeTruthy();
  act(() => explorer.set({ focus: { layer: 20, n: 5928, kind: "neuron" } }));
  const button = screen.getByRole("button", {
    name: "Clear selection: L20 N5928",
  });
  expect(button.textContent).toContain("L20 N5928");
  fireEvent.click(button);
  expect(explorer.getSnapshot().focus).toBeNull();
  expect(screen.queryByRole("button", { name: /Clear selection/ })).toBeNull();
});

it("uses accessible toolbar tabs and supports keyboard navigation", async () => {
  // Avoid a network request for this tab-navigation test.
  explorer.actions.setView = (view) => explorer.set({ view });
  wrap(
    <Tabs defaultValue="map">
      <CanvasControls />
      <TabsContent value="map">Map canvas</TabsContent>
      <TabsContent value="embed">Embedding canvas</TabsContent>
    </Tabs>,
  );
  const map = screen.getByRole("tab", { name: "Map" }),
    embed = screen.getByRole("tab", { name: "Embeddings" });
  const user = userEvent.setup();
  await user.click(map);
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(embed);
  expect(map.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{Enter}");
  expect(embed.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(embed);
});

it("associates selected-unit views and preserves experiment prompt and dose controls", async () => {
  await explorer.actions.select(7, 1870);
  wrap(<SelectionPanel />);
  expect(
    screen.getByRole("tab", { name: "Saved examples", exact: true }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Experiment", exact: true }));
  expect(
    screen
      .getByRole("tabpanel", { name: "Experiment", exact: true })
      .getAttribute("aria-labelledby"),
  ).toBe(screen.getByRole("tab", { name: "Experiment", exact: true }).id);
  fireEvent.change(screen.getByLabelText("dose", { exact: true }), {
    target: { value: "-0.8" },
  });
  fireEvent.blur(screen.getByLabelText("dose", { exact: true }));
  expect(explorer.getSnapshot().chat.dose.add).toBe(-0.8);
  fireEvent.change(screen.getByLabelText("Generation prompt"), {
    target: { value: "Draft" },
  });
  expect(explorer.getSnapshot().chat.prompt).toBe("Draft");
});

it("preserves the mounted assistant composer when switching inspector panels", async () => {
  await explorer.actions.select(7, 1870);
  assistant.set({ draft: "Keep this investigation question" });
  wrap(
    <>
      <AssistantSidebar />
      <ExplorerTools />
    </>,
  );
  const composer = await screen.findByLabelText("Assistant message");
  await waitFor(() =>
    expect(composer.value).toBe("Keep this investigation question"),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Analyze", exact: true }));
  expect(screen.getByRole("textbox", { name: "Assistant message" })).toBe(
    composer,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Inspect", exact: true }));
  expect(screen.getByLabelText("Assistant message")).toBe(composer);
  expect(composer.value).toBe("Keep this investigation question");
});

it("requires explicit confirmation to clear experiment results and preserves them on cancel", async () => {
  await explorer.actions.select(7, 1870);
  explorer.actions.setTab("chat");
  explorer.actions.chatSet({
    thread: [
      {
        user: "A test prompt",
        mode: "add",
        dose: 1,
        replies: ["Positive", "Baseline", "Negative"],
      },
    ],
  });
  wrap(<SelectionPanel />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Clear", exact: true }));
  expect(
    screen.getByRole("alertdialog", { name: "Clear experiment results?" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(explorer.getSnapshot().chat.thread).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Clear", exact: true }));
  await user.click(
    screen.getByRole("button", { name: "Clear results", exact: true }),
  );
  expect(explorer.getSnapshot().chat.thread).toHaveLength(0);
});

it("shows saved evaluation metrics without implying random controls exist when none were sampled", async () => {
  mockApi({
    "/api/unit": () =>
      json({
        name: "",
        rank: 2,
        n_ranked: 20,
        stats: {
          mass: 4.5,
          z: 3,
          null_pct: null,
          words: [],
          per_prompt: {},
          dose: {},
        },
      }),
  });
  await explorer.actions.select(7, 1870);
  wrap(<SelectionPanel />);
  expect(screen.getByText("2 / 20")).toBeTruthy();
  expect(screen.getByText("No controls available")).toBeTruthy();
});

it("renders neuron names as text and navigates result rows by keyboard", async () => {
  explorer.set({
    units: {
      0: [
        {
          kind: "neuron",
          n: 12,
          z: 8,
          words: ["token"],
          name: "<img onerror=alert(1)>",
        },
      ],
    },
  });
  wrap(<SearchPanel />);
  expect(screen.getByText("<img onerror=alert(1)>")).toBeTruthy();
  expect(document.querySelector("img")).toBe(null);
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Open L0 N12" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(explorer.getSnapshot().focus?.n).toBe(12));
});

it("runs text analysis only on submission and preserves both tool drafts", async () => {
  explorer.actions.openTool("search");
  const fetcher = mockApi({
    "/api/infer": () => json({ ready: true, tokens: ["A passage"], pos: [0] }),
    "/api/infer/view": () => json({ total: 0, results: [] }),
    "/api/search": () => json({ ready: true, total: 0, results: [] }),
  });
  wrap(<ExplorerTools />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search token associations" }),
    { target: { value: "concept" } },
  );
  fireEvent.click(screen.getByRole("tab", { name: "Analyze", exact: true }));
  fireEvent.change(screen.getByLabelText("Text to analyze"), {
    target: { value: "A passage" },
  });
  expect(fetcher.mock.calls.some(([url]) => url === "/api/infer")).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Analyze text", exact: true }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === "/api/infer")).toBe(true),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Search", exact: true }));
  expect(
    screen.getByRole("textbox", { name: "Search token associations" }).value,
  ).toBe("concept");
  fireEvent.click(screen.getByRole("tab", { name: "Analyze", exact: true }));
  expect(screen.getByLabelText("Text to analyze").value).toBe("A passage");
});

it("shows a scoped search error and retries the same query", async () => {
  let attempts = 0;
  mockApi({
    "/api/search": () => {
      if (++attempts === 1) throw new Error("Search unavailable");
      return json({ ready: true, total: 0, results: [] });
    },
  });
  wrap(<SearchPanel />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search token associations" }),
    { target: { value: "concept" } },
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Search unavailable"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(attempts).toBe(2));
  expect(screen.queryByRole("alert")).toBe(null);
});

it("edits the latest turn through the official inline editor and preserves server rewind semantics", async () => {
  const fetcher = mockApi({
    "/api/agent/rewind": () => json({ ok: true }),
    "/api/agent/send": () => json({ chat: "editing", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(
        [
          { seq: 1, t: "user", text: "Updated question" },
          { seq: 2, t: "text", text: "Updated answer" },
          { seq: 3, t: "done" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      ),
  });
  assistant.set({
    chat: "editing",
    messages: [
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "Original question" }],
        metadata: {
          custom: { original: "Original question", shown: "Original question" },
        },
      },
      {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "Original answer" }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  fireEvent.mouseEnter(
    container.querySelector('[data-slot="aui_user-message-root"]'),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
  fireEvent.change(container.querySelector(".aui-edit-composer-input"), {
    target: { value: "Updated question" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update", exact: true }));
  expect(await screen.findByText("Updated answer")).toBeTruthy();
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/rewind")[1].body,
    ).text,
  ).toBe("Original question");
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
    ).message,
  ).toBe("Updated question");
});
