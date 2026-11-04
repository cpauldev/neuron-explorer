import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import {
  glowPoints,
  connectionMaterial,
  setLineSegments,
} from "./scene-materials.js";
import { webGeometry } from "./scene-web.js";

const keyOf = (target) => `${target.kind}/${target.layer}/${target.n}`;
const identity = (focus) => focus?.targets.map(keyOf).join("|") || "";

/** Temporary scene presentation only. Never changes selection, camera, or inspector state. */
export function createChatSceneFocus({
  scene,
  camera,
  canvas,
  labels,
  palette,
  neuronPosition,
  headPosition,
  selection,
  render,
  count,
  webStyle = {},
  renderIcon,
}) {
  const root = new THREE.Group();
  root.name = "chat-focus";
  scene.add(root);
  const points = new THREE.Points(new THREE.BufferGeometry(), glowPoints(6, 2));
  const rings = new THREE.Points(
    new THREE.BufferGeometry(),
    glowPoints(13, 1.7, false, true),
  );
  const cursor = new THREE.Points(
    new THREE.BufferGeometry(),
    glowPoints(7, 1.7),
  );
  cursor.geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0], 3),
  );
  cursor.geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute([1, 1, 1], 3),
  );
  const lines = new LineSegments2(
    new LineSegmentsGeometry(),
    connectionMaterial(2.2),
  );
  const webLines = new LineSegments2(
    new LineSegmentsGeometry(),
    connectionMaterial(webStyle.width || 1.8),
  );
  const webPoints = new THREE.Points(
    new THREE.BufferGeometry(),
    glowPoints(3.7, 1.8),
  );
  webPoints.material.uniforms.network.value = 1;
  cursor.name = "chat-focus-cursor";
  rings.name = "chat-focus-targets";
  for (const object of [points, rings, cursor, lines, webLines, webPoints]) {
    object.frustumCulled = false;
    object.material.depthTest = false;
    object.renderOrder = 5;
    root.add(object);
  }
  const label = document.createElement("div");
  label.className = "chat-scene-focus";
  label.setAttribute("role", "status");
  label.setAttribute("aria-live", "polite");
  label.hidden = true;
  const icon = document.createElement("div"),
    caption = document.createElement("div");
  icon.className = "chat-scene-focus-icon";
  icon.setAttribute("aria-hidden", "true");
  label.append(icon, caption);
  const disposeIcon = renderIcon?.(icon);
  labels.append(label);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const position = new THREE.Vector3(),
    from = new THREE.Vector3(),
    to = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const cameraPoint = new THREE.Vector3();
  const lastDirection = { x: 1, y: 0 };
  let requested = null,
    shown = null,
    transition = null,
    alpha = 0,
    contextAlpha = 0,
    labelText = "",
    disposed = false;
  root.visible = false;
  const locate = (target) =>
    target.kind === "head"
      ? headPosition(target.layer, target.n)
      : neuronPosition(target.layer, target.n);
  const center = (focus) => {
    const result = new THREE.Vector3();
    for (const target of focus.targets) result.add(locate(target));
    return result.multiplyScalar(1 / focus.targets.length);
  };
  const sameSelection = (focus = shown) =>
    focus?.targets.length === 1 &&
    keyOf(focus.targets[0]) === (selection() ? keyOf(selection()) : "");
  function pointData(object, positions, colors) {
    object.geometry.dispose();
    object.geometry = new THREE.BufferGeometry();
    object.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    object.geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(colors, 3),
    );
  }
  function rebuild() {
    if (!shown) return;
    const pp = [],
      pc = [],
      rp = [],
      rc = [],
      lp = [],
      lc = [],
      la = [];
    let webData = null;
    const dot = (p, color) => {
      pp.push(...p.toArray());
      pc.push(...color.toArray());
    };
    const edge = (a, b, color, opacity) => {
      lp.push(...a.toArray(), ...b.toArray());
      lc.push(...color.toArray(), ...color.toArray());
      la.push(opacity);
      dot(b, color);
    };
    for (const target of shown.targets) {
      const p = locate(target);
      rp.push(...p.toArray());
      rc.push(...palette.named.toArray());
      dot(p, palette.named);
    }
    for (const network of shown.networks || []) {
      const origin = locate(network.target);
      if (network.web?.length)
        webData = webGeometry(network.web, network.target, {
          count,
          position: neuronPosition,
          palette,
          ...webStyle,
        });
      const max = Math.max(1, ...network.links.map((link) => link.z));
      for (const link of network.links) {
        const color = link.role
          ? palette[link.role] || palette.link
          : link.sign > 0
            ? palette.up
            : link.sign < 0
              ? palette.down
              : palette.link;
        const far = link.layer * count + link.n;
        const on =
          !webData ||
          (link.layer < network.target.layer
            ? webData.fed.has(far)
            : webData.feeds.has(far));
        edge(
          origin,
          neuronPosition(link.layer, link.n),
          color,
          on ? 0.45 + 0.5 * Math.min(1, link.z / max) : 0.12,
        );
      }
    }
    pointData(points, pp, pc);
    pointData(rings, rp, rc);
    setLineSegments(lines, lp, lc, la);
    pointData(
      webPoints,
      webData?.pointPositions || [],
      webData?.pointColors || [],
    );
    webPoints.geometry.setAttribute(
      "pointOpacity",
      new THREE.Float32BufferAttribute(webData?.pointOpacity || [], 1),
    );
    setLineSegments(
      webLines,
      webData?.positions || [],
      webData?.colors || [],
      webData?.opacity || [],
    );
  }
  function set(focus) {
    if (disposed) return;
    if (identity(focus) === identity(requested)) {
      requested = focus;
      if (shown && identity(shown) === identity(focus)) {
        const changed = shown.networks !== focus.networks;
        shown = focus;
        if (changed) rebuild();
      }
      render();
      return;
    }
    requested = focus;
    from.copy(position);
    if (focus) {
      to.copy(center(focus));
      if (!shown) {
        position.copy(to);
        from.copy(to);
      }
    } else to.copy(position);
    transition = {
      at: performance.now(),
      duration: motion.matches ? 0 : 360,
      swapped: false,
      initial: alpha,
      muteFrom: contextAlpha,
    };
    render();
  }
  function update(now, referenceDistance, distance) {
    if (disposed) return false;
    if (transition) {
      const t = transition.duration
        ? Math.min(1, (now - transition.at) / transition.duration)
        : 1;
      const ease = t * t * (3 - 2 * t);
      contextAlpha = THREE.MathUtils.lerp(
        transition.muteFrom,
        requested && !sameSelection(requested) ? 1 : 0,
        ease,
      );
      position.lerpVectors(from, to, ease);
      if (requested) {
        if (!transition.swapped && (t >= 0.4 || !shown)) {
          shown = requested;
          rebuild();
          transition.swapped = true;
        }
        alpha =
          transition.initial && t < 0.4
            ? transition.initial * (1 - t / 0.4)
            : Math.min(
                1,
                (t - (transition.initial ? 0.4 : 0)) /
                  (transition.initial ? 0.6 : 1),
              );
      } else alpha = transition.initial * (1 - ease);
      if (t === 1) {
        transition = null;
        if (!requested) shown = null;
      }
    } else contextAlpha = requested && !sameSelection(requested) ? 1 : 0;
    root.visible = !!shown && alpha > 0;
    label.hidden = !root.visible;
    if (shown) {
      const same = sameSelection();
      // The existing selected network is already correct when both focuses coincide.
      for (const object of [points, rings, webPoints, lines, webLines])
        object.visible =
          !same &&
          (!object.isLineSegments2 || object.geometry.instanceCount > 0);
      cursor.visible = shown.targets.length === 1;
      cursor.geometry.attributes.position.setXYZ(
        0,
        position.x,
        position.y,
        position.z,
      );
      cursor.geometry.attributes.position.needsUpdate = true;
      cursor.geometry.attributes.color.setXYZ(
        0,
        palette.named.r,
        palette.named.g,
        palette.named.b,
      );
      cursor.geometry.attributes.color.needsUpdate = true;
      for (const object of [points, rings, cursor, webPoints]) {
        object.material.uniforms.opacity.value = alpha;
        object.material.uniforms.ref.value = referenceDistance;
        object.material.uniforms.tdist.value = distance;
      }
      lines.material.opacity = alpha;
      webLines.material.opacity = alpha;
      // OrbitControls changes the pose before Three's render pass updates its matrices.
      // Project against the current pose, including the final frame of a drag or zoom.
      camera.updateMatrixWorld();
      projected.copy(position).project(camera);
      cameraPoint.copy(position).applyMatrix4(camera.matrixWorldInverse);
      const offscreen =
        cameraPoint.z >= 0 ||
        projected.z < -1 ||
        projected.z > 1 ||
        Math.abs(projected.x) > 1 ||
        Math.abs(projected.y) > 1;
      const target = shown.targets[0];
      const kind = shown.targets.every((item) => item.kind === target.kind)
        ? target.kind === "head"
          ? "heads"
          : "neurons"
        : "units";
      const text = `${shown.action} ${shown.targets.length === 1 ? `L${target.layer} ${target.kind === "head" ? "h" : "N"}${target.n}` : `${shown.targets.length} ${kind}`}`;
      if (text !== labelText) {
        caption.textContent = text;
        label.setAttribute("aria-label", `Chat: ${text}`);
        labelText = text;
      }
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      const labelW = label.offsetWidth,
        labelH = label.offsetHeight;
      // Camera-space direction avoids the mirrored projection of a target behind the camera.
      let dx = (cameraPoint.x * camera.projectionMatrix.elements[0] * w) / 2;
      let dy = (-cameraPoint.y * camera.projectionMatrix.elements[5] * h) / 2;
      if (Math.hypot(dx, dy) > 0.001) {
        lastDirection.x = dx;
        lastDirection.y = dy;
      } else {
        dx = lastDirection.x;
        dy = lastDirection.y;
      }
      let x = ((projected.x + 1) / 2) * w + 14;
      let y = ((1 - projected.y) / 2) * h - 14;
      if (offscreen) {
        const halfW = Math.max(0, (w - labelW) / 2 - 12);
        const halfH = Math.max(0, (h - labelH) / 2 - 12);
        const scale = Math.min(
          dx ? halfW / Math.abs(dx) : Infinity,
          dy ? halfH / Math.abs(dy) : Infinity,
        );
        x = w / 2 + dx * scale - labelW / 2;
        y = h / 2 + dy * scale - labelH / 2;
      }
      label.style.transform = `translate3d(${Math.max(12, Math.min(w - label.offsetWidth - 12, x))}px,${Math.max(12, Math.min(h - label.offsetHeight - 12, y))}px,0)`;
      label.style.opacity = String(alpha);
    }
    return !!transition;
  }
  const onMotion = () => {
    if (transition && motion.matches) {
      transition.duration = 0;
      render();
    }
  };
  motion.addEventListener("change", onMotion);
  return {
    set,
    update,
    get mute() {
      return contextAlpha;
    },
    get active() {
      return !!shown;
    },
    get layer() {
      return shown?.targets.length === 1 ? shown.targets[0].layer : undefined;
    },
    resize(w, h) {
      lines.material.resolution.set(w, h);
      webLines.material.resolution.set(w, h);
    },
    rebuild() {
      if (shown) {
        to.copy(center(requested || shown));
        if (!transition) position.copy(to);
        rebuild();
      }
    },
    dispose() {
      disposed = true;
      disposeIcon?.();
      motion.removeEventListener("change", onMotion);
      label.remove();
      // GPU resources are owned by the parent scene's shared disposal pass.
    },
  };
}
