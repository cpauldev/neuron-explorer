import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createChatSceneFocus } from "../../explorer/static/chat-scene-focus.js";
import { mapPalette } from "../../explorer/static/map-palette.js";
import { webGeometry } from "../../explorer/static/scene-web.js";

let focus, scene, labels, clock, selected, motion, camera, canvas;
const target = (n) => ({ layer: 1, n, kind: "neuron" });
const payload = (n) => ({
  action: "Testing",
  targets: [target(n)],
  networks: [{ target: target(n), links: [{ layer: 2, n: 3, sign: 1, z: 4 }] }],
});

it("uses the same signed colors and dead-end attenuation for both scene networks", () => {
  const palette = mapPalette("light");
  const data = webGeometry(
    new Int16Array([1, 0, 2, 0, 20, 1, 2, 0, 3, 0, -10, 2]),
    { layer: 1, n: 0 },
    { count: 10, position: (l, n) => new THREE.Vector3(l, n, 0), palette },
  );
  expect(data.opacity[0]).toBeGreaterThan(0.12);
  expect(data.opacity[1]).toBeCloseTo(0.035);
  expect([...data.colors.slice(0, 3)]).toEqual(
    palette.up.toArray().map(Math.fround),
  );
  expect([...data.colors.slice(6, 9)]).toEqual(
    palette.down.toArray().map(Math.fround),
  );
});
beforeEach(() => {
  clock = vi.spyOn(performance, "now").mockReturnValue(0);
  selected = target(0);
  motion = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => motion);
  scene = new THREE.Scene();
  labels = document.createElement("div");
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.z = 20;
  camera.updateMatrixWorld();
  canvas = { clientWidth: 800, clientHeight: 600 };
  focus = createChatSceneFocus({
    scene,
    camera,
    canvas,
    labels,
    palette: mapPalette("light"),
    neuronPosition: (l, n) => new THREE.Vector3(l, n, 0),
    headPosition: (l, n) => new THREE.Vector3(l, n, 1),
    selection: () => selected,
    render: vi.fn(),
  });
});
afterEach(() => {
  focus.dispose();
  scene.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("moves the cursor without moving selection and keeps context muted between targets", () => {
  focus.set(payload(2));
  focus.update(360, 20, 20);
  expect(focus.mute).toBe(1);
  expect(selected).toEqual(target(0));
  expect(labels.textContent).toBe("Testing L1 N2");
  expect(labels.firstChild.getAttribute("aria-label")).toBe(
    "Chat: Testing L1 N2",
  );
  clock.mockReturnValue(1000);
  focus.set(payload(6));
  focus.rebuild(); // A theme/layout repaint must not redirect an in-flight move to the old target.
  focus.update(1180, 20, 20);
  const position =
    scene.getObjectByName("chat-focus-cursor").geometry.attributes.position;
  expect(position.getY(0)).toBeCloseTo(4);
  expect(focus.mute).toBe(1);
  focus.update(1360, 20, 20);
  expect(position.getY(0)).toBeCloseTo(6);
  clock.mockReturnValue(1400);
  focus.set(null);
  focus.update(1760, 20, 20);
  expect(focus.mute).toBe(0);
  expect(labels.firstChild.hidden).toBe(true);
  expect(focus.update(1800, 20, 20)).toBe(false);
});
it("does not mute an identical selection and shows batches as a set", () => {
  selected = target(2);
  focus.set(payload(2));
  focus.update(360, 20, 20);
  expect(focus.mute).toBe(0);
  expect(scene.getObjectByName("chat-focus-targets").visible).toBe(false);
  clock.mockReturnValue(400);
  focus.set({
    action: "Comparing",
    targets: [target(2), target(3)],
    networks: [],
  });
  focus.update(760, 20, 20);
  expect(
    scene.getObjectByName("chat-focus-targets").geometry.attributes.position
      .count,
  ).toBe(2);
  expect(scene.getObjectByName("chat-focus-cursor").visible).toBe(false);
  expect(labels.textContent).toBe("Comparing 2 neurons");
});

it("reprojects after orbit/zoom and docks within a resized view when the target is behind the camera", () => {
  focus.set(payload(2));
  focus.update(360, 20, 20);
  const label = labels.firstChild,
    before = label.style.transform;
  camera.position.set(6, 3, 14);
  camera.lookAt(0, 0, 0);
  focus.update(400, 20, 14);
  expect(label.style.transform).not.toBe(before);
  expect(label.textContent).toBe("Testing L1 N2");
  camera.updateMatrixWorld();
  const expected = new THREE.Vector3(1, 2, 0).project(camera);
  expect(label.style.transform).toContain(
    `${Math.max(12, Math.min(788, ((expected.x + 1) / 2) * 800 + 14))}px`,
  );
  const afterOrbit = label.style.transform;
  camera.position.multiplyScalar(0.5);
  camera.lookAt(0, 0, 0);
  focus.update(420, 20, 7);
  expect(label.style.transform).not.toBe(afterOrbit);
  camera.updateMatrixWorld();
  const zoomed = new THREE.Vector3(1, 2, 0).project(camera);
  expect(label.style.transform).toContain(
    `${Math.max(12, Math.min(788, ((zoomed.x + 1) / 2) * 800 + 14))}px`,
  );
  canvas.clientWidth = 240;
  canvas.clientHeight = 160;
  camera.lookAt(6, 3, 30);
  focus.update(440, 20, 14);
  expect(label.textContent).toBe("Testing L1 N2");
  const [x, y] = label.style.transform
    .match(/-?\d+(?:\.\d+)?/g)
    .map(Number)
    .slice(1, 3);
  expect(x).toBeGreaterThanOrEqual(12);
  expect(x).toBeLessThanOrEqual(228);
  expect(y).toBeGreaterThanOrEqual(12);
  expect(y).toBeLessThanOrEqual(148);
  expect(
    [
      Math.abs(x - 12),
      Math.abs(x - 228),
      Math.abs(y - 12),
      Math.abs(y - 148),
    ].some((distance) => distance < 0.001),
  ).toBe(true);
  expect(selected).toEqual(target(0));
});

it.each([
  [[20, 2, 1], "left", 12],
  [[-20, 2, 1], "right", 668],
  [[1, -20, 1], "top", 12],
  [[1, 20, 1], "bottom", 560],
])(
  "keeps an off-screen target at the %s edge",
  (cameraPosition, edge, boundary) => {
    focus.set(payload(2));
    focus.update(360, 20, 20);
    const label = labels.firstChild;
    Object.defineProperties(label, {
      offsetWidth: { value: 120 },
      offsetHeight: { value: 28 },
    });
    camera.position.set(...cameraPosition);
    focus.update(400, 20, 20);
    const values = label.style.transform.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const coordinate = values[edge === "left" || edge === "right" ? 1 : 2];
    expect(coordinate).toBeCloseTo(boundary);
    expect(label.textContent).toBe("Testing L1 N2");
  },
);

it("keeps chat focus when the user selects another unit, and unmutes an identical selection", () => {
  focus.set(payload(2));
  focus.update(360, 20, 20);
  selected = target(5);
  focus.update(400, 20, 20);
  expect(focus.mute).toBe(1);
  expect(labels.textContent).toBe("Testing L1 N2");
  selected = target(2);
  focus.update(450, 20, 20);
  expect(focus.mute).toBe(0);
  expect(scene.getObjectByName("chat-focus-targets").visible).toBe(false);
  clock.mockReturnValue(500);
  focus.set(null);
  focus.update(860, 20, 20);
  expect(selected).toEqual(target(2));
  expect(focus.mute).toBe(0);
});
it("honors reduced motion and removes its label and listener on disposal", () => {
  motion.matches = true;
  focus.set(payload(5));
  expect(focus.update(0, 20, 20)).toBe(false);
  expect(
    scene
      .getObjectByName("chat-focus-cursor")
      .geometry.attributes.position.getY(0),
  ).toBe(5);
  focus.dispose();
  expect(labels.children).toHaveLength(0);
  expect(motion.removeEventListener).toHaveBeenCalledWith(
    "change",
    expect.any(Function),
  );
});
