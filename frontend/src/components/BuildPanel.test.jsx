import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuildPanel } from "./BuildPanel";
import { ExplorerContext } from "../context";
import { createExplorer } from "../explorer";
import { architecture } from "../test-helpers";

const snapshot = {
  id: "test",
  model: "Qwen/test",
  revision: "pin",
  arch: { ...architecture, n_layers: 2, inter: 4, hidden: 2 },
  running: true,
  pause_requested: false,
  edge_version: "",
  active: { layer: 1, start: 0, end: 4 },
  state: {
    status: "running",
    stage: "layout_writes",
    completed_units: 1,
    total_units: 2,
  },
  stages: [
    { id: "layout_writes", complete: false, neurons: [4, 0], version: "1" },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(model = snapshot.model, revision = "pin", data = snapshot) {
  const fetcher = vi.fn(
    async (url) =>
      new Response(
        JSON.stringify(
          url === "/api/cache-builds"
            ? { jobs: [{ id: "test", model: "Qwen/test" }] }
            : String(url).includes("/layout?")
              ? {
                  cell: btoa(
                    String.fromCharCode(
                      ...new Uint8Array(
                        new Int16Array([3, 2, 1, 0, 0, 1, 2, 3]).buffer,
                      ),
                    ),
                  ),
                }
              : String(url).endsWith("/pause")
                ? { ok: true }
                : data,
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const explorer = createExplorer({
    arch: snapshot.arch,
    model,
    revision,
    layers: {},
  });
  explorer.set({ analysisMode: "build" });
  const paint = vi.spyOn(explorer.actions, "paintBuild"),
    layout = vi.spyOn(explorer.actions, "layoutBuild");
  const view = render(
    <ExplorerContext.Provider value={explorer}>
      <BuildPanel />
    </ExplorerContext.Provider>,
  );
  return { fetcher, explorer, view, paint, layout };
}

it("replays existing checkpoints when the asynchronous renderer becomes ready", async () => {
  const { explorer, paint, layout } = setup();
  await screen.findByText("1 / 2 layers");
  expect(layout).not.toHaveBeenCalled();
  act(() => explorer.set({ mapReady: true }));
  await waitFor(() =>
    expect(layout.mock.calls.some(([cells]) => cells !== null)).toBe(true),
  );
  expect(Array.from(layout.mock.calls.at(-1)[0])).toEqual([
    3, 2, 1, 0, 0, 1, 2, 3,
  ]);
  expect(paint).toHaveBeenCalledWith([4, 0], snapshot.active);
});

it("groups progress and relative update age under the active step without repeated headings", async () => {
  const reading = {
    ...snapshot,
    state: {
      ...snapshot.state,
      stage: "layout_reads",
      eta_seconds: 600,
      updated: Date.now() / 1000 - 90,
    },
    stages: [
      { ...snapshot.stages[0], complete: true, neurons: [4, 4] },
      { id: "layout_reads", complete: false, neurons: [4, 0], version: "2" },
    ],
  };
  setup(snapshot.model, "pin", reading);
  const progress = await screen.findByRole("progressbar", {
    name: "Reads layout progress",
  });
  expect(screen.getAllByText("Reads layout")).toHaveLength(1);
  expect(progress.closest("li").textContent).toContain("1 / 2 layers");
  expect(screen.getByText("≈ 10m left")).toBeTruthy();
  expect(screen.getByText(/Updated .* ago/)).toBeTruthy();
  expect(screen.queryByText(/Next checkpoint/)).toBe(null);
  expect(screen.queryByText(/Use index/)).toBe(null);
});

it("pauses explicitly but leaves the worker alone when the browser view closes", async () => {
  const { fetcher, view } = setup();
  const pause = await screen.findByRole("button", { name: "Pause" });
  fireEvent.click(pause);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, options]) =>
          String(url).endsWith("/pause") && options.method === "POST",
      ),
    ).toBe(true),
  );
  const mutations = fetcher.mock.calls.filter(
    ([, options]) => options.method === "POST",
  ).length;
  view.unmount();
  expect(document.querySelector("canvas")).toBe(null);
  expect(
    fetcher.mock.calls.filter(([, options]) => options.method === "POST"),
  ).toHaveLength(mutations);
});

it.each([
  ["different/model", "pin"],
  ["Qwen/test", "different-revision"],
])(
  "keeps mismatched %s / %s checkpoints off the shared map",
  async (model, revision) => {
    const { explorer, layout, paint } = setup(model, revision);
    if (model !== snapshot.model) {
      const user = userEvent.setup();
      await waitFor(() =>
        expect(screen.getByLabelText("Cache build").disabled).toBe(false),
      );
      await user.click(screen.getByLabelText("Cache build"));
      await user.click(
        screen.getByRole("option", { name: "Qwen/test", exact: true }),
      );
    }
    act(() => explorer.set({ mapReady: true }));
    await screen.findByText(/belongs to a different model/);
    expect(layout).toHaveBeenLastCalledWith(null);
    expect(paint).toHaveBeenLastCalledWith([], null);
  },
);

it("shows the loaded model without silently selecting another model's build", async () => {
  const { fetcher, explorer, paint } = setup("Qwen/loaded-4B");
  act(() => explorer.set({ mapReady: true }));
  await screen.findByText("No resumable build for the loaded model");
  expect(
    screen.getByRole("region", { name: "Loaded model" }).textContent,
  ).toContain("loaded-4B");
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).includes("/api/cache-builds/test"),
    ),
  ).toBe(false);
  expect(paint).toHaveBeenLastCalledWith([], null);
});
