import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { RunActivity } from "./run-activity";
import { assistant, wrap } from "./ui-test-helpers";

it("uses standard saved Markdown and tool activity without typing dots", async () => {
  assistant.set({
    messages: [
      {
        id: "saved",
        role: "assistant",
        content: [{ type: "text", text: "Previously saved answer" }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  await screen.findByText("Previously saved answer");
  expect(container.querySelector(".assistant-stream-word")).toBeNull();
  await act(async () =>
    assistant.set({
      busy: true,
      messages: [
        {
          id: "active-tool",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "overview",
              toolName: "overview",
              args: {},
              argsText: "{}",
            },
          ],
          status: { type: "running" },
          metadata: { custom: {} },
        },
      ],
    }),
  );
  expect(
    screen.queryByRole("status", { name: "Assistant is typing" }),
  ).toBeNull();
  expect(await screen.findByRole("button", { name: "Working" })).toBeTruthy();
});

it("does not repeat the run status as an activity preview", () => {
  const { container } = wrap(
    <RunActivity
      status="running"
      statusLabel="Working"
      entries={[
        {
          id: "comment",
          kind: "commentary",
          label: "Working",
          content: <p>Checking the neuron.</p>,
        },
      ]}
      open={false}
      onOpenChange={() => {}}
    />,
  );
  expect(
    container.querySelector('[data-slot="run-activity"] > div > p'),
  ).toBeNull();
});

it("shows live updates and freezes the work duration when the final response starts", async () => {
  const startedAt = Date.now() - 62000;
  const message = {
    id: "timed-activity",
    role: "assistant",
    status: { type: "running" },
    metadata: { custom: { startedAt, textPhases: { update: "commentary" } } },
    content: [
      {
        type: "text",
        id: "update",
        text: "The first comparison disagrees; I’m checking a fresh example.",
      },
    ],
  };
  assistant.set({ busy: true, messages: [message] });
  wrap(<AssistantPanel active />);
  expect(
    screen
      .getByRole("button", { name: "Working for 1m 2s" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(await screen.findByText(message.content[0].text)).toBeTruthy();
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Working for 1m 3s" }),
      ).toBeTruthy(),
    { timeout: 2000 },
  );
  act(() =>
    assistant.set({
      messages: [
        {
          ...message,
          metadata: {
            custom: {
              ...message.metadata.custom,
              workEndedAt: startedAt + 64000,
            },
          },
          content: [
            ...message.content,
            { type: "text", text: "Final conclusion." },
          ],
        },
      ],
    }),
  );
  expect(
    screen
      .getByRole("button", { name: "Worked for 1m 4s" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(await screen.findByText("Final conclusion.")).toBeTruthy();
  act(() =>
    assistant.set({
      busy: false,
      messages: [
        {
          ...message,
          status: { type: "complete", reason: "stop" },
          metadata: {
            custom: {
              ...message.metadata.custom,
              workEndedAt: startedAt + 64000,
              endedAt: startedAt + 90000,
            },
          },
          content: [
            ...message.content,
            { type: "text", text: "Final conclusion." },
          ],
        },
      ],
    }),
  );
  expect(screen.getByRole("button", { name: "Worked for 1m 4s" })).toBeTruthy();
});

it.each([
  ["cancelled", "Stopped"],
  ["error", "Could not complete"],
])("does not call %s activity successfully worked", (reason, label) => {
  assistant.set({
    messages: [
      {
        id: "failed-activity",
        role: "assistant",
        status: { type: "incomplete", reason },
        metadata: {
          custom: {
            startedAt: 1000,
            endedAt: 4000,
            textPhases: { update: "commentary" },
          },
        },
        content: [{ type: "text", id: "update", text: "Checking the model." }],
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(screen.getByRole("button", { name: `${label} 3s` })).toBeTruthy();
});

it("keeps mixed-run reasoning grouped and the answer outside activity", async () => {
  assistant.set({
    busy: true,
    messages: [
      {
        id: "mixed",
        role: "assistant",
        status: { type: "running" },
        metadata: { custom: { textPhases: { commentary: "commentary" } } },
        content: [
          {
            type: "text",
            id: "commentary",
            text: "I’ll compare the activations.",
          },
          { type: "reasoning", text: "First reasoning part." },
          { type: "reasoning", text: "Second reasoning part." },
          {
            type: "tool-call",
            toolCallId: "comparison",
            toolName: "compare",
            args: {},
            argsText: "{}",
          },
          { type: "text", text: "Answer remains visible." },
        ],
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  expect(await screen.findByText("Answer remains visible.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
  expect(
    screen.getByRole("button", { name: "Running tool: Activation comparison" }),
  ).toBeTruthy();
  expect(
    container.querySelectorAll('[data-slot="reasoning-root"]'),
  ).toHaveLength(1);
  expect(
    container.querySelector('[data-slot="run-activity"] ol')?.textContent || "",
  ).not.toContain("Answer remains visible.");
});

it("queues Enter during a run without implicitly interrupting it", async () => {
  assistant.set({ busy: true });
  const send = vi.spyOn(assistant.actions, "send").mockReturnValue(true);
  const interrupt = vi
    .spyOn(assistant.actions, "interruptQueue")
    .mockResolvedValue();
  wrap(<AssistantPanel active />);
  const input = await screen.findByRole("textbox", {
    name: "Assistant message",
  });
  fireEvent.change(input, { target: { value: "Next question" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledWith("Next question");
  expect(interrupt).not.toHaveBeenCalled();
});

it("keeps an expanded activity mounted as tools and the final answer stream in", async () => {
  const commentary = {
    type: "text",
    id: "progress",
    text: "Checking the model.",
  };
  const message = {
    id: "streamed-activity",
    role: "assistant",
    content: [commentary],
    status: { type: "running" },
    metadata: { custom: { textPhases: { progress: "commentary" } } },
  };
  assistant.set({ busy: true, messages: [message] });
  const { container } = wrap(<AssistantPanel active />);
  expect(await screen.findByRole("button", { name: "Working" })).toBeTruthy();
  const activity = container.querySelector('[data-slot="run-activity"]');
  const tool = {
    type: "tool-call",
    toolCallId: "overview",
    toolName: "mcp__explorer__overview",
    args: {},
    argsText: "{}",
  };
  await act(async () =>
    assistant.set({ messages: [{ ...message, content: [commentary, tool] }] }),
  );
  expect(container.querySelector('[data-slot="run-activity"]')).toBe(activity);
  expect(await screen.findByText("Checking the model.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Running tool: Model overview" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
  expect(
    screen.getByRole("button", { name: "Running tool: Model overview" }),
  ).toBeTruthy();
  await act(async () =>
    assistant.set({
      busy: false,
      messages: [
        {
          ...message,
          status: { type: "complete", reason: "stop" },
          content: [
            commentary,
            { ...tool, result: "Model ready" },
            { type: "text", text: "Final answer." },
          ],
        },
      ],
    }),
  );
  expect(container.querySelector('[data-slot="run-activity"]')).toBe(activity);
  const answer = await screen.findByText("Final answer.");
  expect(answer.closest('[data-slot="run-activity"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Worked" }));
  fireEvent.click(screen.getByRole("button", { name: "1 tool call" }));
  expect(screen.queryByText("mcp__explorer__overview")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Used tool: Model overview" }),
  );
  expect(await screen.findByText("mcp__explorer__overview")).toBeTruthy();
});

it("shows typing dots only before the first visible response", async () => {
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
    screen.getByRole("status", { name: "Assistant is typing" }),
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
    expect(screen.queryByRole("status", { name: "Assistant is typing" })).toBe(
      null,
    ),
  );
  expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
});

it("collapses explicit commentary while keeping answers, findings and failed tools visible", async () => {
  assistant.set({
    messages: [
      {
        id: "activity",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: {
          custom: {
            textPhases: { progress: "commentary", answer: "final_answer" },
            startedAt: 1000,
            endedAt: 6000,
          },
        },
        content: [
          { type: "text", id: "progress", text: "Checking the model" },
          {
            type: "tool-call",
            toolCallId: "bad",
            toolName: "neuron",
            args: {},
            argsText: "{}",
            result: "failure detail",
            isError: true,
          },
          { type: "text", id: "answer", text: "**Verified answer**" },
          {
            type: "text",
            id: "unknown",
            text: "Unclassified text stays visible",
          },
        ],
      },
    ],
  });
  const { container } = wrap(<AssistantPanel active />);
  expect(await screen.findByText("Verified answer")).toBeTruthy();
  expect(screen.getByText("Unclassified text stays visible")).toBeTruthy();
  expect(screen.queryByText("Checking the model")).toBeNull();
  const failure = container.querySelector('[data-slot="tool-fallback-root"]');
  expect(failure).toBeTruthy();
  expect(failure.closest("[data-activity-kind]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Worked for 5s" }));
  expect(await screen.findByText("Checking the model")).toBeTruthy();
  expect(screen.getAllByText("Verified answer")).toHaveLength(1);
});

it("keeps stopped Markdown intact and offers retry only on the latest idle turn", async () => {
  assistant.set({
    messages: [
      {
        id: "stopped",
        role: "assistant",
        content: [{ type: "text", text: "**Partial answer**" }],
        status: { type: "incomplete", reason: "cancelled" },
        metadata: { custom: { stopped: true } },
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(await screen.findByText("Partial answer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry response" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  await act(async () => assistant.set({ busy: true }));
  expect(screen.queryByRole("button", { name: "Retry response" })).toBeNull();
});
