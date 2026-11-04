import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { architecture } from "../test-helpers";
import { createSceneActivity, sceneActivityForTool } from "./scene-activity";

const target = (n, layer = 14) => ({ kind: "neuron", layer, n });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("chat scene activity", () => {
  it("uses validated subjects, not search results or whole-layer interventions", () => {
    expect(
      sceneActivityForTool("search_lens", { query: "music" }, architecture),
    ).toBeNull();
    expect(
      sceneActivityForTool(
        "mcp__explorer__compare",
        {
          neurons: [
            target(2),
            target(2),
            target(3),
            target(99999),
            target(1, 99),
          ],
        },
        architecture,
      ),
    ).toEqual({ action: "Comparing", targets: [target(2), target(3)] });
    expect(
      sceneActivityForTool(
        "logprobs",
        { neurons: [{ layer: 14, all: true, dose: 0 }] },
        architecture,
      ),
    ).toBeNull();
    expect(
      sceneActivityForTool(
        "activations",
        { layer: 14, n: 2, neurons: [target(4)] },
        architecture,
      ),
    ).toEqual({ action: "Measuring", targets: [target(2)] });
    expect(
      sceneActivityForTool("attention", { layer: 3, head: 2 }, architecture),
    ).toEqual({
      action: "Measuring",
      targets: [{ kind: "head", layer: 3, n: 2 }],
    });
    expect(
      sceneActivityForTool("head", { layer: 3, head: "all" }, architecture),
    ).toBeNull();
  });
  it("coalesces concurrent work and changes a completed test to reviewing", () => {
    const display = vi.fn(),
      activity = createSceneActivity(architecture, display);
    activity.apply({ t: "tool", id: "a", name: "steer", input: target(2) });
    activity.apply({ t: "tool", id: "b", name: "steer", input: target(3) });
    expect(display).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(display).toHaveBeenLastCalledWith({
      action: "Testing",
      targets: [target(2), target(3)],
    });
    activity.apply({ t: "tool_result", id: "a" });
    vi.advanceTimersByTime(120);
    expect(display).toHaveBeenLastCalledWith({
      action: "Testing",
      targets: [target(3)],
    });
    activity.apply({ t: "tool_result", id: "b" });
    vi.advanceTimersByTime(120);
    expect(display).toHaveBeenLastCalledWith({
      action: "Reviewing",
      targets: [target(3)],
    });
    activity.apply({ t: "done" });
    expect(display).toHaveBeenLastCalledWith(null);
  });
  it.each(["stopped", "error", "done"])(
    "clears pending delayed focus on %s",
    (t) => {
      const display = vi.fn(),
        activity = createSceneActivity(architecture, display);
      activity.apply({ t: "tool", id: "a", name: "neuron", input: target(2) });
      activity.apply({ t });
      vi.runAllTimers();
      expect(display.mock.calls).toEqual([[null]]);
    },
  );
  it("does not resurrect historical focus or stale focus during global search", () => {
    const display = vi.fn(),
      activity = createSceneActivity(architecture, display);
    activity.restore([
      { t: "tool", id: "a", name: "neuron", input: target(2) },
      { t: "tool_result", id: "a" },
      { t: "done" },
    ]);
    vi.runAllTimers();
    expect(display.mock.calls).toEqual([[null]]);
    activity.restore([
      { t: "user", text: "question" },
      { t: "tool", id: "b", name: "steer", input: target(3) },
    ]);
    vi.advanceTimersByTime(120);
    expect(display).toHaveBeenLastCalledWith({
      action: "Testing",
      targets: [target(3)],
    });
    activity.apply({ t: "tool_result", id: "b" });
    activity.apply({
      t: "tool",
      id: "search",
      name: "search_lens",
      input: { query: "music" },
    });
    vi.runAllTimers();
    expect(display).toHaveBeenLastCalledWith(null);
  });
});
