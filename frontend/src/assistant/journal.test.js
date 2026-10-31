import { describe, expect, it } from "vitest";
import { appendEvent, replayEvents } from "./journal";

describe("assistant journal → assistant-ui messages", () => {
  const events = [
    {
      t: "user",
      seq: 1,
      text: "original",
      shown: "shown",
      attachments: [{ id: "f", name: "input.txt" }],
    },
    { t: "text", seq: 2, text: "First " },
    { t: "text", seq: 3, text: "answer" },
    {
      t: "tool",
      seq: 4,
      id: "call",
      name: "neuron",
      input: { layer: 7, n: 1 },
    },
    { t: "ui", seq: 5, action: "select", layer: 7, n: 1 },
    { t: "tool_result", seq: 6, id: "call", output: '{"name":"test"}' },
    { t: "text", seq: 7, text: "Final answer" },
    { t: "done", seq: 8 },
  ];
  it("keeps stable IDs, tool result pairing, attachments and text/tool ordering", () => {
    const messages = replayEvents(events, "chat");
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("chat:1");
    expect(messages[1].id).toBe("chat:2");
    expect(messages[0].metadata.custom).toMatchObject({
      original: "original",
      shown: "shown",
      files: [{ id: "f", name: "input.txt" }],
    });
    expect(messages[1].content.map((p) => p.type)).toEqual([
      "text",
      "tool-call",
      "text",
    ]);
    expect(messages[1].content[0].text).toBe("First answer");
    expect(messages[1].content[1].result).toBe('{"name":"test"}');
    expect(messages[1].status.type).toBe("complete");
    expect(replayEvents(events, "chat")).toEqual(messages);
  });
  it("expires historical approvals and keeps only currently pending requests actionable", () => {
    const source = [
      ...events.slice(0, 3),
      { t: "approval", seq: 4, id: "a", command: "echo test", cwd: "/tmp" },
    ];
    expect(
      replayEvents(source, "chat")[1].metadata.custom.approvals[0].state,
    ).toBe("expired");
    expect(
      replayEvents(source, "chat", ["a"])[1].metadata.custom.approvals[0].state,
    ).toBe("request");
    expect(
      replayEvents([...source, { t: "done", seq: 5 }], "chat", ["a"])[1]
        .metadata.custom.approvals[0].state,
    ).toBe("expired");
  });
  it("preserves partial text when a run stops and never mutates an earlier snapshot", () => {
    const partial = replayEvents(events.slice(0, 3), "chat");
    const stopped = appendEvent(partial, { t: "stopped", seq: 4 }, "chat");
    expect(stopped[1].status).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
    expect(partial[1].status.type).toBe("running");
    expect(stopped[1].content).toEqual(partial[1].content);
  });
});

it("retains sent selection context during pure journal replay", () => {
  const context = { layer: 16, n: 2311, kind: "neuron" };
  const messages = replayEvents(
    [{ t: "user", seq: 1, text: "Explain it", context }],
    "ctx",
  );
  expect(messages[0].metadata.custom.context).toEqual(context);
});
