import { beforeEach, expect, it, vi } from "vitest";
import {
  sceneColors,
  setSceneColor,
  resetSceneColors,
  SCENE_COLOR_KEY,
  SCENE_COLOR_EVENT,
  coverageColors,
} from "../../../explorer/static/scene-colors.js";
import { mapPalette } from "../../../explorer/static/map-palette.js";

beforeEach(() => localStorage.clear());

it("keeps coverage swatches identical to the rendered map in both themes and after customization", () => {
  for (const scheme of ["light", "dark"]) {
    setSceneColor(scheme, "hi", "#e91e8f");
    const legend = coverageColors(scheme);
    const palette = mapPalette(scheme);
    expect(`#${palette.saved.getHexString()}`).toBe(legend.saved);
    expect(`#${palette.working.getHexString()}`).toBe(legend.working);
    expect(legend.working).toBe("#e91e8f");
  }
});

it("keeps defaults distinct in each theme", () => {
  for (const theme of ["light", "dark"]) {
    const colors = Object.values(sceneColors(theme));
    expect(new Set(colors).size).toBe(colors.length);
  }
});

it("saves normalized colors, notifies the renderer, and preserves the other theme", () => {
  const listener = vi.fn();
  const dark = sceneColors("dark");
  window.addEventListener(SCENE_COLOR_EVENT, listener);
  try {
    expect(setSceneColor("light", "up", "#ABC")).toBeNull();
    expect(sceneColors("light").up).toBe("#aabbcc");
    expect(sceneColors("dark")).toEqual(dark);
    expect(listener).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(SCENE_COLOR_KEY)).light.up).toBe(
      "#aabbcc",
    );
    expect(mapPalette("light").up.getHexString()).toBe("aabbcc");
  } finally {
    window.removeEventListener(SCENE_COLOR_EVENT, listener);
  }
});

it("rejects duplicate and invalid colors without changing saved settings", () => {
  const before = sceneColors("light");
  expect(setSceneColor("light", "down", before.up.toUpperCase())).toMatch(
    /Already used/,
  );
  expect(setSceneColor("light", "down", "invalid")).toMatch(/hex/);
  expect(sceneColors("light")).toEqual(before);
  expect(localStorage.getItem(SCENE_COLOR_KEY)).toBeNull();
});

it("resets only the edited theme", () => {
  const light = sceneColors("light");
  setSceneColor("light", "up", "#abcdef");
  setSceneColor("dark", "down", "#112233");
  expect(resetSceneColors("light")).toBeNull();
  expect(sceneColors("light")).toEqual(light);
  expect(sceneColors("dark").down).toBe("#112233");
});

it("recovers from corrupt storage and duplicate colors introduced outside the UI", () => {
  const defaults = sceneColors("light");
  localStorage.setItem(SCENE_COLOR_KEY, "broken json");
  expect(sceneColors("light")).toEqual(defaults);
  localStorage.setItem(
    SCENE_COLOR_KEY,
    JSON.stringify({ light: { ...defaults, down: defaults.up } }),
  );
  expect(sceneColors("light")).toEqual(defaults);
});

it("updates untouched previous defaults while preserving customized palettes", () => {
  const current = sceneColors("light");
  const previous = {
    bg: "#f8faff",
    idle: "#4285f4",
    slab: "#00897b",
    slabFull: "#f57c00",
    named: "#174ea6",
    hi: "#e37400",
    up: "#e59b00",
    down: "#d93025",
    q: "#188038",
    k: "#9334e6",
    link: "#0097c4",
  };
  localStorage.setItem(SCENE_COLOR_KEY, JSON.stringify({ light: previous }));
  expect(sceneColors("light")).toEqual(current);
  const customized = { ...previous, idle: "#ab12cd" };
  localStorage.setItem(SCENE_COLOR_KEY, JSON.stringify({ light: customized }));
  expect(sceneColors("light")).toEqual(customized);
});
