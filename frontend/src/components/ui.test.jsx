import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExplorerContext, AssistantContext } from "../context";
import { createExplorer } from "../explorer";
import { createAssistant } from "../assistant/store";
import { indexFixture, mockApi, json } from "../test-helpers";
import { Toolbar } from "./Toolbar";
import { SelectionPanel } from "./Inspector";
import { SearchPanel } from "./Analysis";
import { CanvasControls } from "./CanvasControls";
import { AssistantSidebar } from "./AssistantSidebar";
import { ExplorerTools } from "./ExplorerTools";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { Tabs, TabsContent } from "./ui/tabs";

let explorer, assistant;
beforeEach(() => {
  localStorage.clear();
  mockApi();
  explorer = createExplorer(indexFixture);
  assistant = createAssistant(explorer);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  assistant.actions.dispose();
  explorer.actions.dispose();
  vi.unstubAllGlobals();
});
function wrap(children) {
  return render(
    <ExplorerContext.Provider value={explorer}>
      <AssistantContext.Provider value={assistant}>
        {children}
      </AssistantContext.Provider>
    </ExplorerContext.Provider>,
  );
}
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
it("renders real assistant-ui messages, restores its composer and changes providers", async () => {
  assistant.actions.start();
  assistant.actions.draft("Claude draft");
  explorer.actions.openAssistant();
  assistant.set({
    messages: [
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        metadata: { custom: { original: "Hello", shown: "Hello", files: [] } },
      },
      {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "**Answer** with `code`" }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(await screen.findByText("Answer")).toBeTruthy();
  expect(screen.getByText("code")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(
      "Claude draft",
    ),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Assistant settings" }));
  await user.click(
    screen.getByRole("combobox", { name: "Assistant provider" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Codex", exact: true }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(""),
  );
  fireEvent.change(screen.getByLabelText("Assistant message"), {
    target: { value: "Codex draft" },
  });
  expect(assistant.getSnapshot().draft).toBe("Codex draft");
  fireEvent.click(screen.getByRole("button", { name: "Assistant settings" }));
  await user.click(
    screen.getByRole("combobox", { name: "Assistant provider" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Claude", exact: true }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(
      "Claude draft",
    ),
  );
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
it("submits through the assistant-ui Send primitive and renders its streamed answer", async () => {
  const fetcher = mockApi({
    "/api/agent/send": () => json({ chat: "ui-send", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(
        [
          { seq: 1, t: "user", text: "Check component wiring" },
          { seq: 2, t: "text", text: "Wiring works" },
          { seq: 3, t: "done" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      ),
  });
  assistant.actions.start();
  wrap(<AssistantPanel active />);
  fireEvent.change(screen.getByLabelText("Assistant message"), {
    target: { value: "Check component wiring" },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Send message", exact: true })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Send message", exact: true }),
  );
  expect(await screen.findByText("Wiring works")).toBeTruthy();
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
    ).message,
  ).toBe("Check component wiring");
});
it("uses the prebuilt shell approval card without introducing persistent permission", async () => {
  const fetcher = mockApi();
  assistant.set({
    chat: "approvals",
    busy: true,
    messages: [
      {
        id: "approval-message",
        role: "assistant",
        content: [],
        status: { type: "running" },
        metadata: {
          custom: {
            approvals: [
              {
                id: "expired",
                state: "expired",
                command: "old command",
                cwd: "project",
              },
              {
                id: "pending",
                state: "request",
                command: "current command",
                cwd: "project",
              },
            ],
          },
        },
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  expect(
    container.querySelectorAll('[data-slot="approval-card"]'),
  ).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Always allow" })).toBe(null);
  expect(
    screen.getAllByRole("button", { name: "Run command", exact: true }),
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Run command", exact: true }),
  );
  await waitFor(() =>
    expect(
      assistant.getSnapshot().messages[0].metadata.custom.approvals[1].state,
    ).toBe("approved"),
  );
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/approval")[1].body,
    ),
  ).toMatchObject({ id: "pending", allow: true });
});
it("renders official terminal/fallback components from the render-only toolkit", async () => {
  assistant.set({
    messages: [
      {
        id: "tools",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
        content: [
          {
            type: "tool-call",
            toolCallId: "shell",
            toolName: "run_shell",
            args: { command: "echo sample" },
            argsText: '{"command":"echo sample"}',
            result: JSON.stringify({
              output: "sample",
              exit_code: 0,
              truncated: false,
            }),
          },
          {
            type: "tool-call",
            toolCallId: "other",
            toolName: "unknown_research_tool",
            args: {},
            argsText: "{}",
            result: "done",
          },
        ],
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "2 tool calls" }));
  expect(await screen.findByText("echo sample")).toBeTruthy();
  expect(container.querySelector('[data-slot="terminal-block"]')).toBeTruthy();
  expect(
    container.querySelector('[data-slot="tool-fallback-root"]'),
  ).toBeTruthy();
});
it("lets the prebuilt message queue remove an unsent turn", () => {
  assistant.set({
    busy: true,
    queue: [{ id: "later", text: "Later", shown: "Later", atts: [] }],
  });
  const { container } = wrap(<AssistantPanel active />);
  expect(container.querySelector('[data-slot="message-queue"]')).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: 'Remove "Later" from the queue' }),
  );
  expect(assistant.getSnapshot().queue).toHaveLength(0);
});

it("restores uploaded files into official attachment chips and removes them from the saved draft", async () => {
  assistant.set({
    draft: "Unsent question",
    pending: [{ key: "saved-file", id: "upload-1", name: "notes.txt" }],
  });
  const { container } = wrap(<AssistantPanel active />);
  expect(
    await screen.findByRole("button", { name: "Remove notes.txt" }),
  ).toBeTruthy();
  expect(container.querySelector(".aui-composer-attachments")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  await waitFor(() => expect(assistant.getSnapshot().pending).toHaveLength(0));
});
it("uploads with the native attachment control and sends backend-owned file IDs", async () => {
  const fetcher = mockApi({
    "/api/agent/upload": () => json({ id: "native-upload" }),
    "/api/agent/send": () => json({ chat: "files", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(JSON.stringify({ seq: 1, t: "done" }) + "\n"),
  });
  const { container } = wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "Add Attachment" }));
  const input = document.querySelector("input[type=file]");
  fireEvent.change(input, {
    target: {
      files: [new File(["sample"], "native.txt", { type: "text/plain" })],
    },
  });
  await waitFor(() =>
    expect(assistant.getSnapshot().pending[0]?.id).toBe("native-upload"),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Send message", exact: true })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Send message", exact: true }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
      true,
    ),
  );
  const body = JSON.parse(
    fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
  );
  expect(body.attachments).toEqual(["native-upload"]);
  await waitFor(() =>
    expect(
      container.querySelector(".aui-composer-attachments").children,
    ).toHaveLength(0),
  );
});
it("opens saved conversations through the official searchable thread list", async () => {
  mockApi({
    "/api/agent/chats": () =>
      json({
        chats: [
          {
            chat: "saved",
            provider: "claude",
            title: "Circuit investigation",
            updated: 1,
          },
        ],
      }),
    "/api/agent/history": () => json({ events: [], running: false }),
  });
  const { container } = wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Circuit investigation" }),
  );
  await waitFor(() => expect(assistant.getSnapshot().chat).toBe("saved"));
  expect(assistant.getSnapshot().provider).toBe("claude");
  expect(screen.queryByRole("button", { name: "More options" })).toBe(null);
});
it("shows the official loader only before the first visible response", async () => {
  assistant.set({
    busy: true,
    messages: [
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "Question" }],
        metadata: { custom: {} },
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(
    screen.getByRole("status", { name: "Assistant is working" }),
  ).toBeTruthy();
  assistant.set({
    messages: [
      ...assistant.getSnapshot().messages,
      {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "First token" }],
        status: { type: "running" },
        metadata: { custom: {} },
      },
    ],
  });
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Assistant is working" })).toBe(
      null,
    ),
  );
  expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
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

it("selects a discovered model in the composer and passes it to the backend", async () => {
  const fetcher = mockApi({
    "/api/agent/models": () =>
      json({
        models: [
          { id: "default", name: "CLI default" },
          { id: "test-model", name: "Discovered model" },
        ],
      }),
    "/api/agent/send": () => json({ chat: "model-choice", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(JSON.stringify({ seq: 1, t: "done" }) + "\n"),
  });
  wrap(<AssistantPanel active />);
  const picker = screen.getByRole("button", { name: "Assistant model" });
  await waitFor(() => expect(picker.disabled).toBe(false));
  fireEvent.click(picker);
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Discovered model" }),
  );
  expect(assistant.getSnapshot().model).toBe("test-model");
  fireEvent.change(screen.getByLabelText("Assistant message"), {
    target: { value: "Use the selected model" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send message", exact: true }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
      true,
    ),
  );
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
    ).model,
  ).toBe("test-model");
});
it("uses browser dictation, shows recording UI and persists the transcript in the draft", async () => {
  let recognition;
  vi.stubGlobal(
    "SpeechRecognition",
    class extends EventTarget {
      constructor() {
        super();
        recognition = this;
      }
      start() {
        this.dispatchEvent(new Event("start"));
      }
      stop() {
        this.dispatchEvent(new Event("end"));
      }
      abort() {
        this.dispatchEvent(new Event("end"));
      }
    },
  );
  assistant.set({ draft: "Typed before speech" });
  const { container } = wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  expect(screen.getByRole("status", { name: "Voice input" })).toBeTruthy();
  expect(container.querySelector('[data-slot="composer-voice"]')).toBeTruthy();
  const result = new Event("result");
  Object.defineProperties(result, {
    resultIndex: { value: 0 },
    results: {
      value: [
        Object.assign([{ transcript: "spoken words" }], { isFinal: true }),
      ],
    },
  });
  recognition.dispatchEvent(result);
  await waitFor(() =>
    expect(assistant.getSnapshot().draft).toBe(
      "Typed before speech spoken words",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(
      "Typed before speech spoken words",
    ),
  );
});
it("uses an accessible confirmation dialog before clearing an unsent draft", async () => {
  assistant.set({ draft: "Keep this draft" });
  wrap(<AssistantPanel active />);
  fireEvent.click(
    screen.getByRole("button", { name: "New chat", exact: true }),
  );
  expect(
    await screen.findByRole("alertdialog", { name: "Start a new chat?" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(assistant.getSnapshot().draft).toBe("Keep this draft");
});

it("reports denied dictation separately from model failure without resending a message", async () => {
  let recognition;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "SpeechRecognition",
    class extends EventTarget {
      constructor() {
        super();
        recognition = this;
      }
      start() {
        this.dispatchEvent(new Event("start"));
      }
      stop() {
        this.dispatchEvent(new Event("end"));
      }
      abort() {
        this.dispatchEvent(new Event("end"));
      }
    },
  );
  const fetcher = mockApi();
  wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  const denied = new Event("error");
  Object.defineProperties(denied, {
    error: { value: "not-allowed" },
    message: { value: "permission denied" },
  });
  recognition.dispatchEvent(denied);
  expect(await screen.findByText("Voice input unavailable")).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
    false,
  );
});

it("consolidates file access in settings and does not silently expand access", async () => {
  wrap(<AssistantPanel active />);
  expect(
    screen.queryByRole("radiogroup", { name: "Assistant file access" }),
  ).toBe(null);
  fireEvent.click(screen.getByRole("button", { name: "Assistant settings" }));
  expect(
    screen.getByRole("dialog", { name: "Assistant settings" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("radio", { name: /Project only/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(assistant.getSnapshot().access).toBe("project");
  fireEvent.click(
    screen.getByRole("radio", { name: /Project \+ home folder/ }),
  );
  expect(assistant.getSnapshot().access).toBe("home");
});
it("shows and snapshots selected-unit context, with an explicit opt-out", async () => {
  explorer.set({ focus: { layer: 16, n: 2311, kind: "neuron" } });
  const fetcher = mockApi({
    "/api/agent/send": () => json({ chat: "context", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(JSON.stringify({ seq: 1, t: "done" }) + "\n"),
  });
  const { container } = wrap(<AssistantPanel active />);
  expect(
    container.querySelector('[data-slot="selection-context"]').textContent,
  ).toContain("L16");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove selected unit from message context",
    }),
  );
  fireEvent.change(screen.getByLabelText("Assistant message"), {
    target: { value: "General question" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send message", exact: true }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
      true,
    ),
  );
  const body = JSON.parse(
    fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
  );
  expect(body.layer).toBe(undefined);
});
it("operates the compact model menu by keyboard and dismisses without changing the draft", async () => {
  mockApi({
    "/api/agent/models": () =>
      json({
        models: [
          { id: "default", name: "CLI default" },
          { id: "test-model", name: "Discovered model" },
        ],
      }),
  });
  assistant.set({ draft: "Keep my question" });
  const { container } = wrap(<AssistantPanel active />);
  const picker = screen.getByRole("button", { name: "Assistant model" });
  await waitFor(() => expect(picker.disabled).toBe(false));
  expect(container.querySelector('[data-slot="composer-model-trigger"]')).toBe(
    picker,
  );
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  const first = await screen.findByRole("menuitemradio", {
    name: "CLI default",
  });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Discovered model" }),
  );
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Assistant models" })).toBe(null);
  expect(document.activeElement).toBe(picker);
  fireEvent.click(picker);
  fireEvent.pointerDown(screen.getByLabelText("Assistant message"));
  expect(screen.queryByRole("menu", { name: "Assistant models" })).toBe(null);
  expect(assistant.getSnapshot().draft).toBe("Keep my question");
});
const findingsFixture = {
  title: "Requirements in writing advice",
  summary: "This neuron may favor expressions of necessity in writing advice.",
  confidence: "low",
  evidence: [
    {
      source: "neuron",
      kind: "observation",
      text: "The positive steering lens includes writing.",
    },
    {
      source: "web_summary",
      kind: "interpretation",
      text: "Connection tokens suggest requirements, but do not establish a circuit.",
    },
  ],
  caveats: ["No causal test has been run."],
  references: [{ layer: 16, n: 2311, kind: "neuron" }],
  next_steps: [
    {
      label: "Test a control",
      prompt: "Compare writing and cooking instructions for L16 N2311.",
    },
  ],
};
it("omits map actions when findings contain only units outside the current model", async () => {
  const report = {
    ...findingsFixture,
    references: [{ layer: 99, n: 99999, kind: "neuron" }],
  };
  assistant.set({
    messages: [
      {
        id: "invalid-references",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "report",
            toolName: "present_findings",
            args: report,
            argsText: JSON.stringify(report),
            result: JSON.stringify(report),
          },
        ],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(
    await screen.findByRole("region", { name: "Investigation findings" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Highlight referenced neurons" }),
  ).toBe(null);
  expect(screen.queryByLabelText("Referenced units")).toBe(null);
});
it("renders structured findings outside the trace and uses real next-step prompts", async () => {
  const fetcher = mockApi({
    "/api/agent/send": () => json({ chat: "followup", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(JSON.stringify({ seq: 1, t: "done" }) + "\n"),
  });
  assistant.set({
    messages: [
      {
        id: "findings",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "report",
            toolName: "present_findings",
            args: findingsFixture,
            argsText: JSON.stringify(findingsFixture),
            result: JSON.stringify(findingsFixture),
          },
        ],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  const report = await screen.findByRole("region", {
    name: "Investigation findings",
  });
  expect(report.closest('[data-slot="tool-group-root"]')).toBe(null);
  expect(screen.queryByText("Agent assessment · low confidence")).toBe(null);
  expect(screen.getByText("No causal test has been run.")).toBeTruthy();
  expect(container.querySelector('[data-slot="research-report"]')).toBe(null);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Evidence", exact: true }),
  );
  expect(
    await screen.findByText("Agent assessment · low confidence"),
  ).toBeTruthy();
  expect(
    screen.getByText("The positive steering lens includes writing."),
  ).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Test a control", exact: true }),
  );
  expect(
    await screen.findByText(findingsFixture.next_steps[0].prompt),
  ).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
    false,
  );
  await user.click(
    screen.getByRole("button", { name: "Use question", exact: true }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(
      findingsFixture.next_steps[0].prompt,
    ),
  );
  expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
    false,
  );
  await user.click(
    screen.getByRole("button", { name: "Send message", exact: true }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
      true,
    ),
  );
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
    ).message,
  ).toBe(findingsFixture.next_steps[0].prompt);
});
it("renders actual ranked-neuron and probability result schemas", async () => {
  assistant.set({
    messages: [
      {
        id: "data",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
        content: [
          {
            type: "tool-call",
            toolCallId: "rank",
            toolName: "top_firing",
            args: {},
            argsText: "{}",
            result: JSON.stringify({
              neurons: [
                { neuron: "L16 N2311", score: 0.52, steer: ["writing"] },
              ],
            }),
          },
          {
            type: "tool-call",
            toolCallId: "probs",
            toolName: "logprobs",
            args: {},
            argsText: "{}",
            result: JSON.stringify({
              baseline: { targets: [{ text: "must", logprob: Math.log(0.2) }] },
              intervened: {
                targets: [{ text: "must", logprob: Math.log(0.4) }],
              },
            }),
          },
        ],
      },
    ],
  });
  wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "2 tool calls" }));
  expect(await screen.findByText("writing")).toBeTruthy();
  expect(screen.getByText("20.0%")).toBeTruthy();
  expect(screen.getByText("40.0%")).toBeTruthy();
});

it("links valid unit references in prose without rewriting Markdown links or code", async () => {
  const text =
    "Inspect L16 N2311 and [L18 N4325](#L18/N4325). Keep `L16 N2311` literal. Invalid L99 N99999.\n\n```text\nL16 N2311\n```";
  assistant.set({
    messages: [
      {
        id: "references",
        role: "assistant",
        content: [{ type: "text", text }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  await waitFor(() =>
    expect(container.querySelectorAll(".aui-md a")).toHaveLength(2),
  );
  expect(
    container.querySelector('.aui-md a[href="#L16/N2311"]').textContent,
  ).toBe("L16 N2311");
  expect(
    container.querySelector('.aui-md a[href="#L18/N4325"]').textContent,
  ).toBe("L18 N4325");
  expect(container.querySelectorAll(".aui-md code")).toHaveLength(2);
  expect(container.querySelector(".aui-md code a")).toBe(null);
  expect(container.querySelector(".aui-md a a")).toBe(null);
  expect(screen.getByText(/Invalid L99 N99999/)).toBeTruthy();
});

it("labels logit-lens fallback data accurately instead of claiming steering results", async () => {
  assistant.set({
    messages: [
      {
        id: "lens",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
        content: [
          {
            type: "tool-call",
            toolCallId: "neuron",
            toolName: "neuron",
            args: { layer: 16, n: 2311 },
            argsText: "{}",
            result: JSON.stringify({
              neuron: "L16 N2311",
              lens_up: ["writing"],
              lens_down: ["reading"],
            }),
          },
        ],
      },
    ],
  });
  wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
  expect(await screen.findByText("Positive logit lens")).toBeTruthy();
  expect(screen.getByText("Negative logit lens")).toBeTruthy();
  expect(screen.queryByText("Positive steering lens")).toBe(null);
});
