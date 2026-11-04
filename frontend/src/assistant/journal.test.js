import { describe, expect, it } from "vitest";
import { appendEvent, replayEvents } from "./journal";

describe("assistant journal → assistant-ui messages", () => {
  it("freezes work on successful findings but not a rejected report", () => {
    const report = {
      title: "Findings",
      summary: "Scoped conclusion",
      confidence: "low",
      evidence: [{ kind: "observation", source: "test", text: "Evidence" }],
      caveats: [],
      references: [],
      next_steps: [],
    };
    let messages = replayEvents(
      [
        { t: "user", seq: 1, text: "question", at: 100 },
        {
          t: "tool",
          seq: 2,
          id: "bad",
          name: "present_findings",
          input: {},
          at: 101,
        },
        {
          t: "tool_result",
          seq: 3,
          id: "bad",
          output: "Invalid findings",
          error: true,
          at: 102,
        },
      ],
      "reports",
    );
    expect(messages[1].metadata.custom.workEndedAt).toBeUndefined();
    messages = appendEvent(
      messages,
      {
        t: "tool",
        seq: 4,
        id: "good",
        name: "present_findings",
        input: report,
        at: 103,
      },
      "reports",
    );
    messages = appendEvent(
      messages,
      {
        t: "tool_result",
        seq: 5,
        id: "good",
        output: JSON.stringify(report),
        at: 104,
      },
      "reports",
    );
    expect(messages[1].metadata.custom.workEndedAt).toBe(104000);
  });
  it("persists the work boundary at final-answer start, independent of answer streaming", () => {
    const messages = replayEvents(
      [
        { t: "user", seq: 1, text: "question", at: 100 },
        { t: "text", seq: 2, text: "Checking evidence", id: "update", at: 101 },
        { t: "tool", seq: 3, id: "tool", name: "overview", at: 102 },
        { t: "tool_result", seq: 4, id: "tool", output: "ready", at: 103 },
        {
          t: "text_phase",
          seq: 5,
          id: "answer",
          phase: "final_answer",
          at: 104,
        },
        { t: "text", seq: 6, id: "answer", text: "Result", at: 105 },
        { t: "done", seq: 7, at: 110 },
      ],
      "timing",
    );
    expect(messages[1].metadata.custom).toMatchObject({
      startedAt: 100000,
      workEndedAt: 104000,
      endedAt: 110000,
      textPhases: { update: "commentary", answer: "final_answer" },
    });
  });
  it("preserves approval receipts after completion and history replay", () => {
    const messages = replayEvents(
      [
        { t: "user", seq: 1, text: "question" },
        { t: "approval", seq: 2, id: "allowed", command: "echo test" },
        { t: "approval_result", seq: 3, id: "allowed", state: "approved" },
        { t: "approval", seq: 4, id: "rejected", command: "echo declined" },
        { t: "approval_result", seq: 5, id: "rejected", state: "denied" },
        { t: "done", seq: 6 },
      ],
      "approvals",
    );
    expect(messages[1].metadata.custom.approvals.map((a) => a.state)).toEqual([
      "approved",
      "denied",
    ]);
  });
  it("does not label interrupted or failed provider completions as successful", () => {
    for (const status of ["interrupted", "cancelled", "failed"]) {
      const messages = replayEvents(
        [
          { t: "user", seq: 1, text: "question" },
          { t: "text", seq: 2, text: "partial" },
          { t: "done", seq: 3, status },
        ],
        "terminal",
      );
      expect(messages[1].status.type).toBe("incomplete");
      expect(messages[1].status.reason).toBe(
        status === "failed" ? "error" : "cancelled",
      );
      expect(messages[1].content[0].text).toBe("partial");
    }
  });
  it("keeps provider item boundaries, late phase markers and persisted timing on replay", () => {
    const source = [
      { t: "user", seq: 1, text: "question", at: 100 },
      { t: "text_phase", seq: 2, id: "progress", phase: "commentary", at: 101 },
      { t: "text", seq: 3, id: "progress", text: "Checking" },
      { t: "text", seq: 4, id: "answer", text: "Answer" },
      { t: "text_phase", seq: 5, id: "answer", phase: "final_answer" },
      { t: "done", seq: 6, at: 105 },
    ];
    const messages = replayEvents(source, "phases");
    expect(messages[1].content.map((p) => [p.id, p.text])).toEqual([
      ["progress", "Checking"],
      ["answer", "Answer"],
    ]);
    expect(messages[1].metadata.custom).toMatchObject({
      textPhases: { progress: "commentary", answer: "final_answer" },
      startedAt: 100000,
      endedAt: 105000,
    });
    expect(replayEvents(source, "phases")).toEqual(messages);
    const unknown = appendEvent(
      messages,
      { t: "text_phase", id: "answer", phase: "unknown" },
      "phases",
    );
    expect(unknown[1].metadata.custom.textPhases.answer).toBe("final_answer");
  });
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
