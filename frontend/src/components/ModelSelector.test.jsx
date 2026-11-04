import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi, json } from "../test-helpers";
import { ModelSelector, modelOptions } from "./ModelSelector";
import { assistant, wrap } from "./ui-test-helpers";

it("uses the assistant-ui pixel loader while a model switch is pending", async () => {
  mockApi({
    "/api/models": (_, options) =>
      options.method === "POST"
        ? new Promise(() => {})
        : json({
            models: [
              { id: "a", model: "Qwen/4B", revision: null },
              { id: "b", model: "Qwen/9B", revision: null },
            ],
            current: "a",
            generation: "test",
            phase: "idle",
            error: null,
          }),
  });
  wrap(<ModelSelector />);
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" }).disabled).toBe(
      false,
    ),
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "9B" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.querySelector('[data-slot="generation-loader"]')).toBeTruthy();
  expect(dialog.querySelectorAll("[aria-hidden] span").length).toBe(9);
  expect(screen.getByRole("status").textContent).toContain("Loading");
});

it("refreshes local models on return without duplicate scans or a refresh button", async () => {
  const fetcher = mockApi();
  const clock = vi.spyOn(Date, "now").mockReturnValue(20000);
  try {
    wrap(<ModelSelector />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" }).disabled).toBe(
        false,
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Refresh local models" }),
    ).toBeNull();
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([url]) =>
          String(url).includes("refresh=true"),
        ).length,
      ).toBe(1),
    );
    fireEvent(window, new Event("focus"));
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("refresh=true"))
        .length,
    ).toBe(1);
    clock.mockReturnValue(31000);
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([url]) =>
          String(url).includes("refresh=true"),
        ).length,
      ).toBe(2),
    );
  } finally {
    clock.mockRestore();
  }
});

it("shows revision suffixes only for multiple versions of the same model and keeps full details", () => {
  const one = { id: "one", model: "Qwen/Model", revision: "abcdef1234567890" };
  expect(modelOptions([one])[0]).toEqual({
    value: "one",
    label: "Model",
    title: "Qwen/Model\nRevision: abcdef1234567890",
  });
  const options = modelOptions([
    one,
    { ...one, id: "two", revision: "1234567890abcdef" },
  ]);
  expect(options.map((item) => item.label)).toEqual([
    "Model · abcdef1",
    "Model · 1234567",
  ]);
});

it("shows local model choices and reports a rejected switch without leaving the current model", async () => {
  mockApi({
    "/api/models": (_, options) =>
      options.method === "POST"
        ? json({
            error: "Finish the current analysis before switching models.",
          })
        : json({
            models: [
              { id: "a", model: "Qwen/4B", revision: null },
              { id: "b", model: "Qwen/9B", revision: null },
            ],
            current: "a",
            generation: "test",
            phase: "idle",
            error: null,
          }),
  });
  wrap(<ModelSelector />);
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" }).disabled).toBe(
      false,
    ),
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "9B" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Finish the current analysis before switching models.",
  );
  expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain(
    "4B",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
