import { expect, it } from "vitest";
import { findConversationHits } from "./conversation-search";

it("finds literal repeated Unicode text without searching tools or marked commentary", () => {
  const messages = [
    {
      id: "one",
      role: "assistant",
      metadata: { custom: { textPhases: { progress: "commentary" } } },
      content: [
        { type: "text", id: "progress", text: "adjust checking" },
        { type: "tool-call", toolName: "adjust", result: "adjust" },
        { type: "text", id: "answer", text: "Adjust 调整 adjust [x] a+b" },
      ],
    },
  ];
  const hits = findConversationHits(messages, "adjust");
  expect(hits.map((h) => h.match)).toEqual(["Adjust", "adjust"]);
  expect(hits[0].id).not.toBe(hits[1].id);
  expect(hits.every((h) => h.messageId === "one")).toBe(true);
  expect(findConversationHits(messages, "[x]")[0].match).toBe("[x]");
  expect(findConversationHits(messages, "a+b")[0].match).toBe("a+b");
  expect(findConversationHits(messages, "调整")[0].match).toBe("调整");
  expect(findConversationHits(messages, " ")).toEqual([]);
  expect(findConversationHits(messages, "missing")).toEqual([]);
});
