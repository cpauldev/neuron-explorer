import { expect, it } from "vitest";
import { assistantActivity } from "./activity";

it("surfaces current command approval without treating historical requests as active", () => {
  const messages = [
    {
      role: "assistant",
      metadata: { custom: { approvals: [{ state: "request" }] } },
    },
  ];
  expect(assistantActivity({ busy: true, messages })).toBe("approval");
  expect(assistantActivity({ busy: false, messages })).toBe("idle");
  expect(
    assistantActivity({
      busy: true,
      messages: [...messages, { role: "assistant", metadata: { custom: {} } }],
    }),
  ).toBe("working");
});
