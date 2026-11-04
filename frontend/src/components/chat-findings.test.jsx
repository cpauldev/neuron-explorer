import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findingsMarkdown } from "../assistant/research";
import { mockApi, json } from "../test-helpers";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { explorer, assistant, wrap } from "./ui-test-helpers";

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

it("copies and exports full findings from one message action bar", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const createUrl = vi.fn(() => "blob:findings");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = vi.fn();
    },
  );
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  assistant.set({
    messages: [
      {
        id: "exportable-findings",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
        content: [
          { type: "text", text: "Here are the results." },
          {
            type: "tool-call",
            toolCallId: "report",
            toolName: "present_findings",
            args: findingsFixture,
            argsText: JSON.stringify(findingsFixture),
            result: JSON.stringify(findingsFixture),
          },
        ],
      },
    ],
  });
  wrap(<AssistantPanel active />);
  await screen.findByRole("region", { name: "Investigation findings" });
  expect(screen.queryByRole("button", { name: "Copy findings" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save report" })).toBeNull();
  const expected = `Here are the results.\n\n${findingsMarkdown(findingsFixture)}`;
  await user.click(screen.getByRole("button", { name: "Copy", exact: true }));
  expect(copy).toHaveBeenCalledWith(expected);
  await user.click(screen.getByRole("button", { name: "More", exact: true }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Export as Markdown" }),
  );
  expect(createUrl).toHaveBeenCalledOnce();
  const exported = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(createUrl.mock.calls[0][0]);
  });
  expect(exported).toBe(expected);
  expect(download).toHaveBeenCalledOnce();
  expect(download.mock.instances[0].download).toBe("neuron-findings.md");
});

it.each([
  [
    "neuron",
    "Explain this neuron",
    "Explain neuron L16 N2311: investigate what it responds to and how changing it affects the model's output.",
  ],
  [
    "neuron",
    "Investigate connections",
    "Investigate the connections of L16 N2311: examine the neurons it reads from and writes to, explain their possible roles, and distinguish weight-based connections from tested causal effects. Highlight the neurons you mention.",
  ],
  [
    "head",
    "Explain this head",
    "Explain attention head L16 h1: report its q/k/v/o roles and verify its attention on contrasting texts.",
  ],
])(
  "labels the %s starter %s and shows its actual request",
  async (kind, label, prompt) => {
    const fetcher = mockApi({
      "/api/agent/send": () =>
        json({ error: "Test provider unavailable" }, 503),
    });
    explorer.set({ focus: { layer: 16, n: kind === "head" ? 1 : 2311, kind } });
    wrap(<AssistantPanel active />);
    if (kind === "head")
      expect(
        screen.queryByRole("button", { name: "Investigate connections" }),
      ).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: label, exact: true }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) => url === "/api/agent/send"),
      ).toBe(true),
    );
    const [, options] = fetcher.mock.calls.find(
      ([url]) => url === "/api/agent/send",
    );
    expect(JSON.parse(options.body)).toMatchObject({
      message: prompt,
      shown: prompt,
    });
    expect(await screen.findByText(prompt, { exact: true })).toBeTruthy();
  },
);

it("does not offer to repeat a completed investigation with no next steps", async () => {
  explorer.set({ focus: { layer: 16, n: 2311, kind: "neuron" } });
  const findings = {
    ...findingsFixture,
    next_steps: [],
    references: [{ layer: 16, n: 2311, kind: "neuron" }],
  };
  assistant.set({
    messages: [
      {
        id: "finished-investigation",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
        content: [
          {
            type: "tool-call",
            toolCallId: "finished-report",
            toolName: "present_findings",
            args: findings,
            argsText: JSON.stringify(findings),
            result: JSON.stringify(findings),
          },
        ],
      },
    ],
  });
  wrap(<AssistantPanel active />);
  await screen.findByRole("region", { name: "Investigation findings" });
  act(() =>
    assistant.set({
      messages: [
        ...assistant.getSnapshot().messages,
        {
          id: "brief-follow-up",
          role: "assistant",
          status: { type: "complete", reason: "stop" },
          metadata: { custom: {} },
          content: [
            { type: "text", text: "The scoped conclusion remains the same." },
          ],
        },
      ],
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Explain this neuron", exact: true }),
  ).toBeNull();
  act(() => explorer.set({ focus: { layer: 16, n: 2312, kind: "neuron" } }));
  expect(
    await screen.findByRole("button", {
      name: "Explain this neuron",
      exact: true,
    }),
  ).toBeTruthy();
});

it("labels a rejected findings report as failed rather than successfully used", async () => {
  assistant.set({
    messages: [
      {
        id: "rejected-report",
        role: "assistant",
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
        content: [
          {
            type: "tool-call",
            toolCallId: "rejected-findings",
            toolName: "present_findings",
            args: {},
            argsText: "{}",
            result: "Evidence source label exceeds its limit.",
            isError: true,
          },
        ],
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(
    await screen.findByRole("button", {
      name: "Failed tool: Investigation findings",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Used tool: Investigation findings" }),
  ).toBeNull();
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
  fireEvent.click(screen.getByRole("button", { name: /^Worked(?: for .*)?$/ }));
  fireEvent.click(screen.getByRole("button", { name: /tool calls?$/ }));
  expect(await screen.findByText("writing")).toBeTruthy();
  expect(screen.getByText("20.0%")).toBeTruthy();
  expect(screen.getByText("40.0%")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: /^Worked(?: for .*)?$/ }));
  fireEvent.click(screen.getByRole("button", { name: /tool calls?$/ }));
  expect(await screen.findByText("Positive logit lens")).toBeTruthy();
  expect(screen.getByText("Negative logit lens")).toBeTruthy();
  expect(screen.queryByText("Positive steering lens")).toBe(null);
});
