import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ThemeProvider, useTheme } from "./theme-provider";
import { ModeToggle } from "./mode-toggle";

let media;
function Controls() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <output>{theme}</output>
      {["light", "dark", "system"].map((value) => (
        <button key={value} onClick={() => setTheme(value)}>
          {value}
        </button>
      ))}
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  media = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("defaults to light, persists dark, and restores it after remount", () => {
  const view = render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  expect(document.documentElement.className).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "dark" }));
  expect(document.documentElement.className).toBe("dark");
  expect(localStorage.getItem("neuron-explorer-theme")).toBe("dark");
  view.unmount();
  render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  expect(document.documentElement.className).toBe("dark");
});

it("follows live system changes only while System is selected and cleans up", () => {
  const view = render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "system" }));
  expect(document.documentElement.className).toBe("light");
  const listener = media.addEventListener.mock.calls.at(-1)[1];
  act(() => {
    media.matches = true;
    listener();
  });
  expect(document.documentElement.className).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "light" }));
  expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
  expect(document.documentElement.className).toBe("light");
  view.unmount();
});

it("ignores invalid stored values and works when storage is unavailable", () => {
  localStorage.setItem("neuron-explorer-theme", "invalid");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  expect(document.documentElement.className).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "dark" }));
  expect(document.documentElement.className).toBe("dark");
});

it("syncs preference changes from another tab", () => {
  render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "neuron-explorer-theme",
        newValue: "dark",
        storageArea: localStorage,
      }),
    ),
  );
  expect(document.documentElement.className).toBe("dark");
  expect(screen.getByRole("status").textContent).toBe("dark");
});

it("renders the theme selector with its saved selection", () => {
  localStorage.setItem("neuron-explorer-theme", "system");
  render(
    <ThemeProvider>
      <ModeToggle />
    </ThemeProvider>,
  );
  expect(
    screen.getByRole("combobox", { name: "Color theme" }).textContent,
  ).toContain("System");
});
