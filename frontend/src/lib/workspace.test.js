import { expect, it } from "vitest";
import { visiblePanels } from "./workspace";

it("keeps both work areas available on a wide screen and honors individual visibility", () => {
  expect(visiblePanels(true, true, "assistant", false)).toEqual({
    assistant: true,
    tools: true,
  });
  expect(visiblePanels(false, true, null, false)).toEqual({
    assistant: false,
    tools: true,
  });
  expect(visiblePanels(true, false, null, false)).toEqual({
    assistant: true,
    tools: false,
  });
});

it("shows one selected work area at a time in compact layouts, or the canvas when closed", () => {
  expect(visiblePanels(true, true, "assistant", true)).toEqual({
    assistant: true,
    tools: false,
  });
  expect(visiblePanels(true, true, "tools", true)).toEqual({
    assistant: false,
    tools: true,
  });
  expect(visiblePanels(true, true, null, true)).toEqual({
    assistant: false,
    tools: false,
  });
  expect(visiblePanels(false, true, "assistant", true)).toEqual({
    assistant: false,
    tools: false,
  });
});
