import { expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi, json } from "../test-helpers";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { ResearchToolResult } from "../assistant/ResearchToolResult";
import { explorer, assistant, wrap } from "./ui-test-helpers";

it("searches the current conversation, steps through matches, and restores focus on Escape", async () => {
  assistant.set({
    messages: [
      {
        id: "first",
        role: "user",
        content: [{ type: "text", text: "Baseline question" }],
        metadata: { custom: {} },
      },
      {
        id: "second",
        role: "assistant",
        content: [
          { type: "text", text: "Baseline answer and baseline comparison" },
        ],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  const trigger = screen.getByRole("button", { name: "Search conversation" });
  fireEvent.click(trigger);
  const input = screen.getByRole("textbox", { name: "Find in conversation" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "baseline" } });
  expect(screen.getByText("1/3")).toBeTruthy();
  expect(
    container.querySelector('[data-slot="conversation-search"]'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(screen.getByText("2/3")).toBeTruthy();
  expect(
    Element.prototype.scrollIntoView.mock.instances.at(-1).dataset.messageId,
  ).toBe("second");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByText("1/3")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByText("3/3")).toBeTruthy();
  const previous = screen.getByRole("button", { name: "Previous match" });
  previous.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(screen.getByText("2/3")).toBeTruthy();
  fireEvent.change(input, { target: { value: "no match" } });
  expect(screen.queryByRole("button", { name: "Next match" })).toBeNull();
  expect(screen.getByText("0 matches")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(
    screen.queryByRole("textbox", { name: "Find in conversation" }),
  ).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: "Assistant message" }),
    { key: "f", ctrlKey: true },
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Find in conversation" }),
  );
  await act(async () =>
    assistant.set({
      revision: assistant.getSnapshot().revision + 1,
      messages: [],
    }),
  );
  expect(
    screen.queryByRole("textbox", { name: "Find in conversation" }),
  ).toBeNull();
});

it("replaces the official typing indicator with standard Markdown", async () => {
  const message = {
    id: "streaming-motion",
    role: "assistant",
    content: [],
    status: { type: "running" },
    metadata: { custom: {} },
  };
  assistant.set({ busy: true, messages: [message] });
  const { container } = wrap(<AssistantPanel active />);
  expect(
    await screen.findByRole("status", { name: "Assistant is typing" }),
  ).toBeTruthy();
  expect(
    container.querySelectorAll('[data-slot="typing-indicator"] > span'),
  ).toHaveLength(3);
  await act(async () =>
    assistant.set({
      messages: [
        {
          ...message,
          content: [
            {
              type: "text",
              text: "**Bold words** and `code`\n\n- First item\n- Second item",
            },
          ],
        },
      ],
    }),
  );
  await waitFor(() =>
    expect(container.querySelector("strong")?.textContent).toBe("Bold words"),
  );
  expect(
    screen.queryByRole("status", { name: "Assistant is typing" }),
  ).toBeNull();
  expect(container.querySelector(".assistant-stream-word")).toBeNull();
  expect(container.querySelector("code .assistant-stream-word")).toBeNull();
  await waitFor(() =>
    expect(container.querySelectorAll(".aui-md li")).toHaveLength(2),
  );
});

it("provides an explicit way back from past chats", async () => {
  wrap(<AssistantPanel active />);
  fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  const back = await screen.findByRole("button", { name: "Back to chat" });
  expect(screen.getByRole("heading", { name: "Past chats" })).toBeTruthy();
  fireEvent.click(back);
  expect(
    await screen.findByRole("textbox", { name: "Assistant message" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back to chat" })).toBeNull();
});

it("offers one retry control for a failed response", async () => {
  assistant.set({
    messages: [
      {
        id: "failed",
        role: "assistant",
        content: [],
        status: { type: "incomplete", reason: "error" },
        metadata: { custom: { error: "Provider unavailable" } },
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(
    await screen.findByRole("button", { name: "Retry", exact: true }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
});

it.each(["complete", "running"])(
  "preserves full Markdown semantics in a %s response",
  async (state) => {
    const text =
      "# Formatting check\n\nA **bold** and *italic* paragraph with [a link](https://example.com) and `inline_code`.\n\n> A quoted passage.\n\n- First item\n- Second item\n\n| Name | Count |\n| --- | --- |\n| Alpha | 2 |\n\n```python\nprint('hello')\nprint('world')\n```";
    assistant.set({
      busy: state === "running",
      messages: [
        {
          id: "markdown-check",
          role: "assistant",
          content: [{ type: "text", text }],
          status:
            state === "running"
              ? { type: "running" }
              : { type: "complete", reason: "stop" },
          metadata: { custom: {} },
        },
      ],
    });
    const { container } = wrap(<AssistantPanel active />);
    await waitFor(
      () =>
        expect(container.querySelector("pre code")?.textContent).toBe(
          "print('hello')\nprint('world')\n",
        ),
      { timeout: 8000 },
    );
    const markdown = container.querySelector(".aui-md");
    expect(markdown.querySelector("h1")?.textContent).toBe("Formatting check");
    expect(markdown.querySelector("strong")?.textContent).toBe("bold");
    expect(markdown.querySelector("em")?.textContent).toBe("italic");
    expect(
      markdown.querySelector('a[href="https://example.com"]')?.textContent,
    ).toBe("a link");
    expect(markdown.querySelector("blockquote")?.textContent).toContain(
      "A quoted passage.",
    );
    expect(markdown.querySelectorAll("ul li")).toHaveLength(2);
    expect(markdown.querySelectorAll("table tbody tr")).toHaveLength(1);
    expect(markdown.querySelectorAll("table td")).toHaveLength(2);
    expect(markdown.querySelector("pre code")?.textContent).toBe(
      "print('hello')\nprint('world')\n",
    );
    expect(markdown.querySelector("code .assistant-stream-word")).toBeNull();
  },
);

it("does not report a successful exit for a stopped command without a result", () => {
  wrap(
    <ResearchToolResult
      toolName="run_shell"
      args={{ command: "echo test" }}
      result={undefined}
      isError={false}
      status={{ type: "incomplete", reason: "cancelled" }}
    />,
  );
  expect(
    screen.getByText("Command stopped; no execution result was received."),
  ).toBeTruthy();
  expect(screen.queryByText("exit 0")).toBeNull();
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
  fireEvent.click(screen.getByRole("button", { name: /^Worked(?: for .*)?$/ }));
  fireEvent.click(screen.getByRole("button", { name: /tool calls?$/ }));
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
