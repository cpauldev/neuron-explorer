import { SCENE_COLOR_EVENT, SCENE_COLOR_KEY } from "./scene-colors.js";
import { mapPalette } from "./map-palette.js";
import { flightPosition } from "./camera-flight.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LAYER_GAP as GAP, glowPoints, connectionMaterial, setLineSegments, setContextMute } from "./scene-materials.js";
import { webGeometry } from "./scene-web.js";
import { createChatSceneFocus } from "./chat-scene-focus.js";

// geometry: layers run left to right along x. Each layer is the residual stream passing through a token-mixer slab
// (linear or full attention) and then the MLP, drawn as a vertical sheet of its neurons.
const SHEET = 4.2, SHEET_Y0 = 0.7, ATTN_DX = -0.62, MLP_DX = 0.18;

export function createMap(canvas, labelsDiv, arch, cb) {
  let disposed = false;
  let scheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const PAL = mapPalette(scheme);
  let basePaint = null;
  let paletteDirty = false;
  const attenuate = (color, strength) => scheme === "light"
    ? PAL.idle.clone().lerp(color, Math.min(1, strength))
    : color.clone().multiplyScalar(strength);
  const lifetime = new AbortController();
  const listen = (type, fn, options = {}) => canvas.addEventListener(type, fn, { ...options, signal: lifetime.signal });
  const L = arch.n_layers, N = arch.inter;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(PAL.bg);
  const scene = new THREE.Scene();
  const layerX = l => l * GAP;
  const X0 = ATTN_DX - 1.6, X1 = (L - 1) * GAP + MLP_DX + 1.4;

  const insets = { left: 410, right: 0 };
  const TARGET_X = Number(new URLSearchParams(location.search).get("targetx")) || 0;
  let fitPerPx = null;
  const camera = new THREE.PerspectiveCamera(32, 1, 0.02, 2000);
  let homeDist = 60;
  let shadingDist = 60;
  const home = { target: new THREE.Vector3((L - 1) * GAP / 2, SHEET_Y0 + SHEET / 2 - 0.4, 0), dir: new THREE.Vector3(0.62, 0.4, 1).normalize() };
  camera.position.copy(home.target).addScaledVector(home.dir, homeDist);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(home.target);
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  controls.minDistance = 1.6; controls.maxDistance = 400;
  controls.zoomSpeed = 0.6;
  controls.update();

  const gridSide = Math.ceil(Math.sqrt(N));
  let layoutCells = null;  // Int16Array [L * N] of grid cells, or null for neuron-index order
  const neuronPos = (layer, n) => {
    const c = layoutCells ? layoutCells[layer * N + n] : n;
    const i = c % gridSide, j = Math.floor(c / gridSide);
    return new THREE.Vector3(layerX(layer) + MLP_DX, SHEET_Y0 + (j / (gridSide - 1)) * SHEET, (i / (gridSide - 1) - 0.5) * SHEET);
  };

  // every neuron of every layer, one draw call
  const pos = new Float32Array(L * N * 3), col = new Float32Array(L * N * 3);
  for (let l = 0; l < L; l++) for (let n = 0; n < N; n++) {
    const p = neuronPos(l, n), k = (l * N + n) * 3;
    pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
    PAL.idle.toArray(col, k);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pointMat = glowPoints(1.25, 2.6, true);
  const points = new THREE.Points(geo, pointMat);
  scene.add(points);

  // structure
  const wires = [];
  const seg = (a, b) => wires.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const sheetCorners = x => { const h = SHEET / 2; return [V(x, SHEET_Y0, -h), V(x, SHEET_Y0, h), V(x, SHEET_Y0 + SHEET, h), V(x, SHEET_Y0 + SHEET, -h)]; };
  seg(V(X0, 0, 0), V(X1, 0, 0));
  // heads are horizontal lines stacked down the slab's face, head 0 at the top
  const HEAD_SPAN = SHEET * 0.82, HEAD_W = SHEET * 0.41;
  const headY = (h, H) => SHEET_Y0 + SHEET / 2 + (0.5 - (h + 0.5) / H) * HEAD_SPAN;
  const slabs = [], headPos = [], headBase = [], headStart = [];  // headStart[l]: first line of layer l's heads
  for (let l = 0; l < L; l++) {
    const x = layerX(l), mx = x + MLP_DX, ax = x + ATTN_DX, cs = sheetCorners(mx);
    for (let i = 0; i < 4; i++) seg(cs[i], cs[(i + 1) % 4]);
    seg(V(ax, 0, 0), V(ax, SHEET_Y0, 0)); seg(V(mx, 0, 0), V(mx, SHEET_Y0, 0));
    const full = arch.layer_types[l] === "full_attention", t = full ? 0.3 : 0.1;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(t, SHEET * 0.92, SHEET * 0.92), new THREE.MeshBasicMaterial({
      color: full ? PAL.slabFull : PAL.slab, transparent: true, opacity: full ? 0.035 : 0.018, depthWrite: false }));
    slab.position.set(ax, SHEET_Y0 + SHEET / 2, 0);
    slab.userData = { layer: l, full };
    scene.add(slab); slabs.push(slab);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry),
      new THREE.LineBasicMaterial({ color: full ? PAL.slabEdgeFull : PAL.slabEdge, transparent: true }));
    edges.position.copy(slab.position); scene.add(edges);
    slab.userData.edges = edges; slab.userData.baseOpacity = slab.material.opacity;
    const heads = full ? arch.attn_heads : arch.linear_v_heads;
    slab.userData.heads = heads;
    headStart.push(headPos.length / 6);
    for (let h = 0; h < heads; h++) {
      const y = headY(h, heads);
      headPos.push(ax + t / 2 + 0.003, y, -HEAD_W, ax + t / 2 + 0.003, y, HEAD_W);
      headBase.push(full ? PAL.headFull : PAL.head);
    }
  }
  const fadeLines = [];  // whole-scene line work that dims as the camera closes in on one layer
  // the attention heads: one line per head on its layer's slab, coloured one by one
  const headGeo = new THREE.BufferGeometry(); headGeo.setAttribute("position", new THREE.Float32BufferAttribute(headPos, 3));
  const headCol = new Float32Array(headPos.length);
  headGeo.setAttribute("color", new THREE.BufferAttribute(headCol, 3));
  const headMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }); headMat.userData.base = 0.55;
  scene.add(new THREE.LineSegments(headGeo, headMat)); fadeLines.push(headMat);
  let headLevels = null, headSel = null, headHover = null;
  const band = op => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({
    color: PAL.named, transparent: true, opacity: op, depthWrite: false })); m.visible = false; m.renderOrder = 1; scene.add(m); return m; };
  const hoverBand = band(0.1), selBand = band(0.18);
  function placeBand(m, at) {
    m.visible = !!at;
    if (!at) return;
    const s = slabs[at.layer], H = s.userData.heads;
    m.position.set(s.position.x, headY(at.head, H), 0);
    m.scale.set(s.geometry.parameters.width + 0.02, HEAD_SPAN / H * 0.9, HEAD_W * 2 + 0.1);
  }
  function paintHeads() {
    placeBand(hoverBand, headHover && !(headSel && headSel.layer === headHover.layer && headSel.head === headHover.head) ? headHover : null);
    placeBand(selBand, headSel);
    const c = new THREE.Color();
    for (let l = 0; l < L; l++) {
      const H = (headStart[l + 1] ?? headBase.length) - headStart[l];
      for (let h = 0; h < H; h++) {
        const i = headStart[l] + h, lv = headLevels?.[l]?.[h] || 0;
        c.copy(headBase[i]);
        if (headLevels) c.lerp(PAL.bg, 0.65).lerp(PAL.hi, Math.min(1, lv));
        if (headHover && headHover.layer === l && headHover.head === h) c.lerp(PAL.named, 0.5);
        if (headSel && headSel.layer === l && headSel.head === h) c.copy(PAL.named);
        c.toArray(headCol, i * 6); c.toArray(headCol, i * 6 + 3);
      }
    }
    headGeo.attributes.color.needsUpdate = true;
  }
  paintHeads();
  const endSlabs = [];
  for (const x of [X0, X1]) {
    const m = new THREE.LineBasicMaterial({ color: PAL.slabEdgeFull, transparent: true }); m.userData.base = 1;
    const slab = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.14, 1.4, 2.2)), m);
    slab.position.set(x, 0, 0); scene.add(slab); endSlabs.push(m);
  }
  const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.Float32BufferAttribute(wires, 3));
  const wireMat = new THREE.LineBasicMaterial({ color: PAL.wire, transparent: true }); wireMat.userData.base = 1;
  scene.add(new THREE.LineSegments(wg, wireMat)); fadeLines.push(wireMat, ...endSlabs);
  const dataOutline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: PAL.wireData }));
  dataOutline.frustumCulled = false;
  scene.add(dataOutline);
  const bounds = [];
  for (const x of [X0, X1]) for (const y of [-0.8, SHEET_Y0 + SHEET]) for (const z of [-SHEET / 2, SHEET / 2]) bounds.push(V(x, y, z));

  // highlights and connections (their geometry changes every update, so culling is off)
  const hiGeo = new THREE.BufferGeometry();
  const hiMat = glowPoints(6, 2);
  const hiPts = new THREE.Points(hiGeo, hiMat);
  hiPts.frustumCulled = false; hiPts.renderOrder = 3;
  scene.add(hiPts);
  const selectionGeo = new THREE.BufferGeometry();
  const selectionRing = new THREE.Points(selectionGeo, glowPoints(13, 1.7, false, true));
  selectionRing.frustumCulled = false; selectionRing.renderOrder = 4;
  selectionRing.material.depthTest = false;
  scene.add(selectionRing);
  const conMat = connectionMaterial(2.2);
  const conLines = new LineSegments2(new LineSegmentsGeometry(), conMat);
  conLines.frustumCulled = false; conLines.renderOrder = 3; conLines.visible = false;
  scene.add(conLines);
  hiMat.depthTest = false;
  // connection web of the selected neuron: upstream and downstream cones, coloured by link sign, fading per hop.
  const qs = new URLSearchParams(location.search);
  const WEB_ALPHA = Number(qs.get("webalpha")) || 0.72, WEB_DECAY = Number(qs.get("webdecay")) || 0.85;
  const WEB_UP = PAL.up, WEB_DOWN = PAL.down, HEAD_LINK = PAL.link;
  const HEAD_ROLE = { q: PAL.q, k: PAL.k, v: HEAD_LINK, o: HEAD_LINK };
  // Screen-space lines retain their width and semantic hue at every distance, outside the
  // zoom fade, so the web stays bright up close
  const webMat = connectionMaterial(Number(qs.get("webwidth")) || 1.8);
  const webLines = new LineSegments2(new LineSegmentsGeometry(), webMat);
  webLines.frustumCulled = false; webLines.renderOrder = 2; webLines.visible = false;
  scene.add(webLines);
  const webPtGeo = new THREE.BufferGeometry(), webPts = new THREE.Points(webPtGeo, glowPoints(3.7, 1.8));
  webPts.frustumCulled = false; webPts.material.depthTest = false; webPts.material.uniforms.network.value = 1; webPts.renderOrder = 4; webPts.visible = false;
  scene.add(webPts);
  let webEdges = null;
  const webFed = new Set(), webFeeds = new Set();  // neurons the drawn web reads into / out of (layer * N + n)
  function buildWeb() {
    webFed.clear(); webFeeds.clear();
    if (!webEdges?.length) { webLines.visible = false; webPts.visible = false; return; }
    const data = webGeometry(webEdges, selected, { count: N, position: neuronPos, palette: PAL, alphaBase: WEB_ALPHA, decay: WEB_DECAY });
    for (const id of data.fed) webFed.add(id);
    for (const id of data.feeds) webFeeds.add(id);
    webPtGeo.setAttribute("position", new THREE.Float32BufferAttribute(data.pointPositions, 3));
    webPtGeo.setAttribute("color", new THREE.Float32BufferAttribute(data.pointColors, 3));
    webPtGeo.setAttribute("pointOpacity", new THREE.Float32BufferAttribute(data.pointOpacity, 1));
    webPts.visible = true;
    setLineSegments(webLines, data.positions, data.colors, data.opacity);
  }
  let selected = null, hovered = null, connections = [], hoverCon = null, headSrc = null;  // headSrc: an open head's line middle
  let neuronHeads = [];  // the open neuron's strongest linked heads: {layer, head, z}
  const headMid = (layer, head) => { const i = (headStart[layer] + head) * 6;
    return new THREE.Vector3((headPos[i] + headPos[i + 3]) / 2, (headPos[i + 1] + headPos[i + 4]) / 2, (headPos[i + 2] + headPos[i + 5]) / 2); };
  const markGeo = new THREE.BufferGeometry();
  const markPts = new THREE.Points(markGeo, glowPoints(4, 2));
  markPts.frustumCulled = false; markPts.renderOrder = 1;
  scene.add(markPts);
  const chatSceneFocus = createChatSceneFocus({
    scene, camera, canvas, labels: labelsDiv, palette: PAL, neuronPosition: neuronPos, headPosition: headMid,
    selection: () => selected ? { ...selected, kind: "neuron" } : headSel ? { layer: headSel.layer, n: headSel.head, kind: "head" } : null,
    render, renderIcon: cb.createChatFocusIcon, count: N, webStyle: { alphaBase: WEB_ALPHA, decay: WEB_DECAY, width: Number(qs.get("webwidth")) || 1.8 },
  });


  function refreshHighlights() {
    const anchor = selected ? neuronPos(selected.layer, selected.n) : headSel ? headMid(headSel.layer, headSel.head) : null;
    selectionGeo.setAttribute("position", new THREE.Float32BufferAttribute(anchor ? anchor.toArray() : [], 3));
    selectionGeo.setAttribute("color", new THREE.Float32BufferAttribute(anchor ? PAL.named.toArray() : [], 3));
    const p = [], c = [];
    const add = (l, n, color) => { const v = neuronPos(l, n); p.push(v.x, v.y, v.z); c.push(color.r, color.g, color.b); };
    const src = hoverCon ? hoverCon.src : selected, shown = hoverCon ? hoverCon.list : connections;
    const zmax = Math.max(...shown.map(k => k.z), 1);
    // Direct links share the signed-link palette; attention links carry a role instead.
    // head links carry a role instead of a sign
    const linkCol = k => (k.role ? HEAD_ROLE[k.role] : k.sign > 0 ? WEB_UP : k.sign < 0 ? WEB_DOWN : HEAD_LINK).clone();
    for (const k of shown) add(k.layer, k.n, linkCol(k));
    if (hovered) add(hovered.layer, hovered.n, attenuate(PAL.named, 0.7));
    if (selected) add(selected.layer, selected.n, PAL.named);
    if (headSrc && !selected) { p.push(headSrc.x, headSrc.y, headSrc.z); c.push(PAL.named.r, PAL.named.g, PAL.named.b); }
    hiGeo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    hiGeo.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
    const lp = [], lc = [], la = [];
    const a = src ? neuronPos(src.layer, src.n) : hoverCon ? hoverCon.from : headSrc;
    if (a) {
      for (const k of shown) {
        // with the web on, a direct link stays bright only if the web goes on past its far end
        const far = k.layer * N + k.n, on = !webEdges || !webEdges.length || hoverCon
          || (k.side === "up" ? webFed.has(far) : webFeeds.has(far));
        const b = neuronPos(k.layer, k.n), cl = linkCol(k);
        la.push(on ? 0.45 + 0.5 * Math.min(1, k.z / zmax) : 0.12);
        lp.push(a.x, a.y, a.z, b.x, b.y, b.z); lc.push(cl.r, cl.g, cl.b, cl.r, cl.g, cl.b);
      }
    }
    if (selected && !hoverCon && neuronHeads.length) {
      const o = neuronPos(selected.layer, selected.n), hz = Math.max(...neuronHeads.map(k => k.z));
      for (const k of neuronHeads) {
        const b = headMid(k.layer, k.head), cl = HEAD_LINK;
        la.push(0.45 + 0.5 * Math.min(1, k.z / hz));
        lp.push(o.x, o.y, o.z, b.x, b.y, b.z); lc.push(cl.r, cl.g, cl.b, cl.r, cl.g, cl.b);
      }
    }
    setLineSegments(conLines, lp, lc, la);
    render();
  }

  // layer labels: text drawn in each layer's plane, just above the top-right corner of its neuron sheet
  const LABEL_H = Number(new URLSearchParams(location.search).get("labelsize")) || 0.2;
  const labelFont = `600 64px ${getComputedStyle(canvas).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace"}`;
  function drawLayerLabel(cv, layer) {
    const ctx = cv.getContext("2d");
    ctx.font = labelFont;
    const width = Math.ceil(ctx.measureText(`L${layer}`).width) + 8;
    cv.width = width; cv.height = 80;
    ctx.font = labelFont; ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
    ctx.fillText(`L${layer}`, 4, 42);
    return LABEL_H * width / 80;
  }
  const labels = [];
  for (let l = 0; l < L; l++) {
    const cv = document.createElement("canvas"), w = drawLayerLabel(cv, l);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, depthTest: false, color: PAL.label });
    mat.userData.base = 0.85;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, LABEL_H), mat);
    // the plane's +x runs toward -z after this turn, so the text reads toward the sheet's right edge seen from +x
    m.rotation.y = Math.PI / 2;
    m.position.set(layerX(l) + MLP_DX, SHEET_Y0 + SHEET + 0.08 + LABEL_H / 2, -SHEET / 2 + w / 2);
    m.userData = { layer: l };
    m.renderOrder = 5;
    scene.add(m); labels.push(m);
  }
  // Canvas textures do not repaint automatically when the local font loads.
  document.fonts?.load(labelFont, "L0").then(() => {
    if (disposed) return;
    labels.forEach((mesh, layer) => {
      const width = drawLayerLabel(mesh.material.map.image, layer);
      mesh.userData.fontScale = width / mesh.geometry.parameters.width;
      mesh.position.z = -SHEET / 2 + width / 2;
      mesh.material.map.needsUpdate = true;
    });
    render();
  }).catch(() => {}); // Retain the system-font texture if font loading fails.
  const dataLayers = new Set();
  let unitsLayer = null;

  // annotations: short HTML labels pinned to neurons, re-projected every frame (the assistant points things out with these)
  let notes = [];
  function placeNotes() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const a of notes) {
      const v = neuronPos(a.layer, a.n).project(camera);
      a.el.style.display = v.z > 1 || layerMode !== null && a.layer !== layerMode ? "none" : "";
      a.el.style.left = `${(v.x + 1) / 2 * w}px`; a.el.style.top = `${(1 - v.y) / 2 * h}px`;
    }
  }
  function setNotes(items) {
    for (const a of notes) a.el.remove();
    notes = (items || []).map(it => {
      // a zero-size anchor at the neuron: the ring is centred on it, the text sits to its right
      const el = document.createElement("div"); el.className = "note";
      const t = document.createElement("span"); t.textContent = it.text || `L${it.layer} N${it.n}`; el.appendChild(t);
      labelsDiv.appendChild(el); return { layer: it.layer, n: it.n, el };
    });
    render();
  }

  function updateTheme() {
    const next = document.documentElement.classList.contains("dark") ? "dark" : "light";
    if (next !== scheme || paletteDirty) {
      paletteDirty = false;
      scheme = next;
      const nextPalette = mapPalette(scheme);
      for (const key of Object.keys(PAL)) PAL[key].copy(nextPalette[key]);
      for (let i = 0; i < L * N; i++) PAL.idle.toArray(col, i * 3);
      if (basePaint) basePaint();
      geo.attributes.color.needsUpdate = true;
      wireMat.color.copy(PAL.wire);
      dataOutline.material.color.copy(PAL.wireData);
      for (const mat of endSlabs) mat.color.copy(PAL.slabEdgeFull);
      for (const slab of slabs) {
        slab.material.color.copy(slab.userData.full ? PAL.slabFull : PAL.slab);
        slab.userData.edges.material.color.copy(slab.userData.full ? PAL.slabEdgeFull : PAL.slabEdge);
      }
      hoverBand.material.color.copy(PAL.named); selBand.material.color.copy(PAL.named);
      paintHeads(); buildWeb(); refreshHighlights(); chatSceneFocus.rebuild(); api.setMarks(lastMarks);
    }
    renderer.setClearColor(PAL.bg);
    const projected = new THREE.Vector3();
    let previous = null;
    const focusLayer = chatSceneFocus.layer ?? selected?.layer ?? headSel?.layer;
    labels.forEach((label, layer) => {
      const distance = camera.position.distanceTo(label.position);
      const scale = THREE.MathUtils.clamp(2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 12 / Math.max(canvas.clientHeight, 1) / LABEL_H, 0.65, 30);
      label.material.color.copy(layer === focusLayer ? PAL.named : PAL.label);
      label.quaternion.copy(camera.quaternion);
      label.scale.set((label.userData.fontScale || 1) * scale, scale, 1);
      projected.copy(label.position).project(camera);
      const screen = {x: projected.x * canvas.clientWidth / 2, y: projected.y * canvas.clientHeight / 2};
      label.visible = projected.z < 1 && (layer === focusLayer || !previous || Math.hypot(screen.x - previous.x, screen.y - previous.y) >= 25);
      if (label.visible) previous = screen;
    });
  }

  const recolor = () => { paletteDirty = true; render(); };
  const onColorStorage = event => { if (event.key === SCENE_COLOR_KEY || event.key === null) recolor(); };
  window.addEventListener(SCENE_COLOR_EVENT, recolor);
  window.addEventListener("storage", onColorStorage);
  // Canvas materials need an explicit redraw when the shared CSS theme changes.
  const themeObserver = new MutationObserver(() => render());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  let pending = false;
  function render() {
    if (pending || disposed) return; pending = true;
    requestAnimationFrame(() => {
      if (disposed) return;
      pending = false;
      for (const m of [pointMat, hiMat, markPts.material, webPts.material, selectionRing.material]) { m.uniforms.ref.value = shadingDist; m.uniforms.tdist.value = curDist(); }
      updateTheme();
      const moving = chatSceneFocus.update(performance.now(), shadingDist, curDist());
      const mute = chatSceneFocus.mute;
      for (const material of [hiMat, markPts.material, webPts.material, selectionRing.material, conMat, webMat])
        setContextMute(material, mute, PAL.idle);
      selBand.material.color.copy(PAL.named).lerp(PAL.idle, mute);
      pointMat.uniforms.idleColor.value.copy(PAL.idle);
      applyFade();
      renderer.render(scene, camera); placeNotes();
      if (moving) render();
    });
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h || disposed) return;
    renderer.setSize(w, h, false);
    webMat.resolution.set(w, h); conMat.resolution.set(w, h); chatSceneFocus.resize(w, h);
    const narrow = innerWidth <= 760, li = narrow ? 0 : insets.left, ri = narrow ? 0 : insets.right;
    const availW = Math.max(200, w - li - ri);
    camera.aspect = w / h;
    {
      // Fit the model bounds in the visible gap along the home camera axes.
      const center = home.target, r = Math.max(...bounds.map(b => b.distanceTo(center)));
      const vHalf = THREE.MathUtils.degToRad(camera.fov / 2), hHalf = Math.atan(Math.tan(vHalf) * availW / h);
      const right = new THREE.Vector3().crossVectors(camera.up, home.dir).normalize();
      const up = new THREE.Vector3().crossVectors(home.dir, right).normalize();
      const fitDistance = Math.max(...bounds.map(bound => {
        const offset = bound.clone().sub(center), depth = offset.dot(home.dir);
        return depth + Math.max(Math.abs(offset.dot(right)) / Math.tan(hHalf), Math.abs(offset.dot(up)) / Math.tan(vHalf));
      }));
      homeDist = fitDistance * 1.12;
      // Keep point-density normalization stable when improving the overview framing.
      shadingDist = r / Math.sin(Math.min(vHalf, hHalf)) * 0.82;
      if (fitPerPx === null) {
        camera.position.copy(home.target).addScaledVector(home.dir, homeDist);
        controls.update();
        fitPerPx = homeDist;
      }
    }
    // the orbit target (and vanishing point) sits in the middle of the visible gap between the list and the neuron
    // panel, or at ?targetx= of the canvas width
    const tx = TARGET_X ? w * TARGET_X : li + availW / 2;
    camera.setViewOffset(w, h, w / 2 - tx, 0, w, h);
    camera.updateProjectionMatrix(); render();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  controls.addEventListener("change", render);

  // picking
  const ray = new THREE.Raycaster(); ray.params.Points.threshold = 0.05;
  const mouse = new THREE.Vector2();
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    mouse.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(mouse, camera);
    // hits come sorted by depth; on a sheet seen at an angle several neighbours fall within the threshold, so take
    // the frontmost layer's hits and pick the point closest to the ray
    // a head is under the pointer when its line is within a few pixels on screen (on the nearest visible slab that
    // has one); it wins over a neuron only when its slab is in front of that neuron
    const px = v => { v.project(camera); return Math.hypot((v.x + 1) / 2 * r.width - (ev.clientX - r.left), (1 - v.y) / 2 * r.height - (ev.clientY - r.top)); };
    let headHit = null;
    // the open head's dot, where its links meet
    if (headSrc && headSel && px(headSrc.clone()) < 8) {
      const sl = slabs[headSel.layer].userData;
      headHit = { type: "head", layer: headSel.layer, full: sl.full, head: headSel.head, distance: ray.ray.origin.distanceTo(headSrc) };
    }
    for (const sh of headHit ? [] : ray.intersectObjects(slabs)) {
      if (sh.object.material.opacity <= 0.005) continue;  // faded slabs don't pick
      const { layer, full, heads } = sh.object.userData;
      // where the ray crosses the face the head lines are drawn on
      const lx = sh.object.position.x + sh.object.geometry.parameters.width / 2;
      if (Math.abs(ray.ray.direction.x) < 1e-6) continue;
      const on = ray.ray.origin.clone().addScaledVector(ray.ray.direction, (lx - ray.ray.origin.x) / ray.ray.direction.x);
      if (Math.abs(on.z) > HEAD_W) continue;  // past the ends of the lines
      const head = Math.floor((0.5 - (on.y - SHEET_Y0 - SHEET / 2) / HEAD_SPAN) * heads);
      if (head < 0 || head >= heads) continue;
      if (px(new THREE.Vector3(lx, headY(head, heads), on.z)) < 6) { headHit = { type: "head", layer, full, head, distance: sh.distance }; break; }
    }
    const hits = ray.intersectObject(points);
    if (hits.length && !(headHit && headHit.distance < hits[0].distance)) {
      // the frontmost layer that is actually visible at the current fade, then the point closest to the ray in it
      const layers = [...new Set(hits.map(h => Math.floor(h.index / N)))];
      const front = layers.find(l => layerVisibility(l) > 0.5) ?? layers.reduce((a, b) => layerVisibility(b) > layerVisibility(a) ? b : a);
      let best = null;
      for (const h of hits) if (Math.floor(h.index / N) === front && (!best || h.distanceToRay < best.distanceToRay)) best = h;
      return { type: "neuron", layer: front, n: best.index % N };
    }
    if (headHit) return headHit;
    const lb = ray.intersectObjects(labels)[0];
    if (lb) return { type: "block", layer: lb.object.userData.layer };
    const b = ray.intersectObjects(slabs).find(x => x.object.material.opacity > 0.005);
    if (b) return { type: "block", ...b.object.userData };
    return null;
  }
  canvas.style.cursor = "grab";
  let moveQueued = null, downAt = null;
  listen("pointermove", ev => {
    if (moveQueued) { moveQueued = ev; return; }
    moveQueued = ev;
    requestAnimationFrame(() => {
      if (disposed) return;
      const e = moveQueued; moveQueued = null;
      const p = pick(e);
      canvas.style.cursor = e.buttons ? "grabbing" : p ? "pointer" : "grab";
      const h = p && p.type === "neuron" ? { layer: p.layer, n: p.n } : null;
      if (JSON.stringify(h) !== JSON.stringify(hovered)) { hovered = h; refreshHighlights(); }
      const hh = p && p.type === "head" ? { layer: p.layer, head: p.head } : null;
      if (JSON.stringify(hh) !== JSON.stringify(headHover)) { headHover = hh; paintHeads(); render(); }
      cb.onHover(p, e.clientX, e.clientY);
    });
  });
  listen("pointerleave", () => { hovered = null; refreshHighlights(); if (headHover) { headHover = null; paintHeads(); render(); } cb.onHover(null); });
  listen("pointerdown", ev => { downAt = [ev.clientX, ev.clientY]; canvas.style.cursor = "grabbing"; });
  listen("pointerup", ev => {
    canvas.style.cursor = "grab";
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
    const p = pick(ev);
    if (p && p.type === "neuron") cb.onPick(p.layer, p.n);
    else if (p && p.type === "head") cb.onPickHead && cb.onPickHead(p.layer, p.head);
    else if (p && p.type === "block") cb.onPickLayer && cb.onPickLayer(p.layer);
  });

  // the closer the camera is to the orbit target, the more the layers away from the target's x fade out
  const fade = { fx: 0, fw: 1, amt: 0, side: 1 };
  const layerVisibility = l => {
    const dx = layerX(l) + MLP_DX - fade.fx, d = dx / fade.fw;
    if (dx * fade.side / GAP > 0.45) return 1 - fade.amt;
    return 1 - 0.75 * fade.amt * (1 - Math.exp(-d * d));
  };
  let layerMode = null, saved = null, lastMarks = [];
  function enterLayer(l) {
    if (layerMode === null) saved = { pos: camera.position.clone(), tgt: controls.target.clone() };
    layerMode = l;
    const c = new THREE.Vector3(layerX(l) + MLP_DX, SHEET_Y0 + SHEET / 2, 0);
    const dist = (SHEET / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.12;
    controls.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(-dist, 0, 0));
    controls.enableRotate = false;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.update(); render(); cb.onLayerMode && cb.onLayerMode(l);
  }
  function exitLayer() {
    if (layerMode === null) return;
    layerMode = null;
    controls.enableRotate = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    camera.position.copy(saved.pos); controls.target.copy(saved.tgt);
    controls.update(); render(); cb.onLayerMode && cb.onLayerMode(null);
  }

  function applyFade() {
    pointMat.uniforms.isolate.value = layerMode === null ? 0 : 1;
    const focused = !!(selected || headSel || chatSceneFocus.active);
    pointMat.uniforms.focused.value = focused ? 1 : 0;
    if (layerMode !== null) {
      const fx = layerX(layerMode) + MLP_DX;
      pointMat.uniforms.focusX.value = fx; pointMat.uniforms.fadeW.value = 0.05; pointMat.uniforms.fadeAmt.value = 1;
      fade.fx = fx; fade.fw = 0.05; fade.amt = 1;
      for (const slab of slabs) { slab.material.opacity = 0; slab.userData.edges.material.opacity = 0; }
      for (let l = 0; l < L; l++) labels[l].material.opacity = 0;
      for (const m of fadeLines) m.opacity = 0;
      dataOutline.visible = false;
      return;
    }
    dataOutline.visible = true;
    dataOutline.material.transparent = true; dataOutline.material.opacity = 0.5;
    // continuous in zoom: eased on log-distance from the overview (no fade) to a sheet filling the view (full fade)
    const dist = camera.position.distanceTo(controls.target);
    const far = Math.log(shadingDist * 0.7), near = Math.log(shadingDist * 0.07);
    const amt = focused ? THREE.MathUtils.smoothstep(THREE.MathUtils.clamp((far - Math.log(dist)) / (far - near), 0, 1), 0, 1) : 0;
    // the focus is the layer whose sheet centre lands closest to the middle of the view on screen
    const tv = controls.target.clone().project(camera), pv = new THREE.Vector3();
    let fx = controls.target.x, best = Infinity;
    for (let l = 0; l < L; l++) {
      pv.set(layerX(l) + MLP_DX, SHEET_Y0 + SHEET / 2, 0).project(camera);
      const dd = Math.hypot((pv.x - tv.x) * camera.aspect, pv.y - tv.y);
      if (pv.z < 1 && dd < best) { best = dd; fx = layerX(l) + MLP_DX; }
    }
    const focusLayer = chatSceneFocus.layer ?? selected?.layer ?? headSel?.layer ?? hovered?.layer ?? headHover?.layer;
    if (focusLayer != null) fx = layerX(focusLayer) + MLP_DX;
    const fw = GAP * (0.85 + 2.5 * (1 - amt));
    const side = Math.sign(camera.position.x - fx) || 1;
    pointMat.uniforms.focusX.value = fx; pointMat.uniforms.fadeW.value = fw; pointMat.uniforms.fadeAmt.value = amt;
    pointMat.uniforms.camSide.value = side;
    fade.fx = fx; fade.fw = fw; fade.amt = amt; fade.side = side;
    for (const slab of slabs) {
      const d = (slab.position.x - fx) / fw, f = 1 - amt * (1 - Math.exp(-d * d));
      slab.material.opacity = slab.userData.baseOpacity * f; slab.userData.edges.material.opacity = f * (scheme === "light" ? 0.42 : 0.65);
    }
    for (let l = 0; l < L; l++) {
      const d = (layerX(l) + MLP_DX - fx) / fw;
      labels[l].material.opacity = labels[l].material.userData.base * (1 - 0.2 * amt * (1 - Math.exp(-d * d)));  // other layers keep half
    }
    for (const m of fadeLines) m.opacity = m.userData.base * (1 - 0.9 * amt) * (scheme === "light" ? 0.5 : 0.7);
  }

  let flight = 0;
  controls.addEventListener("start", () => { flight++; });
  function flyTo(target, dist, direction = null) {
    const mine = ++flight, duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450;
    const from = controls.target.clone(), to = target.clone();
    const offset = camera.position.clone().sub(controls.target);
    const t0 = performance.now();
    (function step(t) {
      if (mine !== flight) return;
      const k = duration ? Math.min(1, (t - t0) / duration) : 1, e = k * k * (3 - 2 * k);
      controls.target.lerpVectors(from, to, e);
      camera.position.copy(flightPosition(controls.target, offset, dist, e, direction));
      controls.update(); render();
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  const curDist = () => camera.position.distanceTo(controls.target);

  // face a layer's neuron sheet head-on, close enough that the neighbours fade away
  function viewLayer(layer) {
    const mine = ++flight, duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600;
    const c = new THREE.Vector3(layerX(layer) + MLP_DX, SHEET_Y0 + SHEET / 2, 0);
    const dist = (SHEET / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25;
    const from = controls.target.clone(), p0 = camera.position.clone();
    const p1 = c.clone().add(new THREE.Vector3(dist, 0.0001, 0)), t0 = performance.now();
    (function step(t) {
      if (mine !== flight) return;
      const k = duration ? Math.min(1, (t - t0) / duration) : 1, e = k * k * (3 - 2 * k);
      controls.target.lerpVectors(from, c, e); camera.position.lerpVectors(p0, p1, e);
      controls.update(); render();
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  const api = {
    neuronPos,
    resetBuildProgress() {
      basePaint = null;
      for (let i = 0; i < L * N; i++) PAL.idle.toArray(col, i * 3);
      geo.attributes.color.needsUpdate = true;
      render();
    },
    // Build observer colours are independent of scientific activation/steering scores.
    /** @param {number[]} counts @param {{layer: number, start: number, end: number} | null} active */
    setBuildProgress(counts, active = null) {
      basePaint = () => api.setBuildProgress(counts, active);
      // Coverage shares the map palette; point opacity adapts to viewing distance.
      const saved = PAL.saved, working = PAL.working, pending = PAL.pending;
      for (let l = 0; l < L; l++) for (let n = 0; n < N; n++) {
        const current = active && active.layer === l && n >= active.start && n < active.end;
        (current ? working : n < (counts[l] || 0) ? saved : pending).toArray(col, (l * N + n) * 3);
      }
      geo.attributes.color.needsUpdate = true;
      render();
    },
    // heads lit by level (0..1 per head, per layer; null clears), and the selected head
    setHeadLevels(levels) { headLevels = levels; paintHeads(); render(); },
    selectHead(layer, head) {
      headSel = layer == null ? null : { layer, head };
      if (!headSel && headSrc) { headSrc = null; connections = []; refreshHighlights(); }
      paintHeads(); refreshHighlights();
    },
    // an open head's strongest neuron links, drawn from the middle of its line like a neuron's direct links
    setHeadLinks(layer, head, list) {
      const i = (headStart[layer] + head) * 6;
      headSrc = headMid(layer, head);
      connections = list.map(k => ({ ...k, sign: 0 }));
      refreshHighlights();
    },
    // a hovered head's links, previewed like a hovered neuron's (null clears)
    setHoverHead(layer, head, list) {
      hoverCon = layer == null ? null : { from: headMid(layer, head), list: list.map(k => ({ ...k, sign: 0 })) };
      refreshHighlights();
    },
    // mark a head as hovered from outside the map (null clears)
    hoverHead(layer, head) {
      const hh = layer == null ? null : { layer, head };
      if (JSON.stringify(hh) !== JSON.stringify(headHover)) { headHover = hh; paintHeads(); render(); }
    },
    // the open neuron's strongest linked heads, drawn from the neuron to each head's line
    setNeuronHeads(list) { neuronHeads = list || []; refreshHighlights(); },
    // the swept neurons' colours show on one layer at a time (the current one); the others go back to idle
    setUnits(layer, units) {
      basePaint = () => api.setUnits(layer, units);
      if (unitsLayer !== null && unitsLayer !== layer) for (let n = 0; n < N; n++) PAL.idle.toArray(col, (unitsLayer * N + n) * 3);
      unitsLayer = layer;
      dataLayers.add(layer);
      labels[layer].material.userData.base = 1; labels[layer].material.color.set(0xffffff);
      const zs = units.filter(u => u.kind === "neuron").map(u => u.z);
      const rnd = units.filter(u => u.kind === "random").map(u => u.z);
      const floor = rnd.length ? Math.max(...rnd) : Math.min(...zs), top = Math.max(...zs, floor + 1e-6);
      for (const u of units) {
        if (u.kind !== "neuron") continue;
        let c = PAL.swept;
        if (u.name) c = PAL.named;
        else if (u.z > floor) c = PAL.lo.clone().lerp(PAL.hi, Math.min(1, (u.z - floor) / (top - floor)));
        c.toArray(col, (layer * N + u.n) * 3);
      }
      geo.attributes.color.needsUpdate = true;
      const dl = [];
      for (const l of dataLayers) {
        const cs = sheetCorners(layerX(l) + MLP_DX);
        for (let i = 0; i < 4; i++) dl.push(...cs[i].toArray(), ...cs[(i + 1) % 4].toArray());
      }
      dataOutline.geometry.setAttribute("position", new THREE.Float32BufferAttribute(dl, 3));
      render();
    },
    // fly: bring the neuron into view without ever zooming out from where the user is
    select(layer, n, fly = true) {
      selected = layer == null ? null : { layer, n };
      connections = []; headSrc = null; neuronHeads = [];
      refreshHighlights();
      if (!fly || layer == null || layerMode !== null) return;
      // off screen (or behind the camera): fly to it, never zooming out from where the user is
      const v = neuronPos(layer, n).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) flyTo(neuronPos(layer, n), Math.min(curDist(), homeDist * 0.35));
    },
    setChatFocus(focus) { chatSceneFocus.set(focus); },
    setConnections(con) {
      connections = [...con.down.map(c => ({ ...c, side: "down" })), ...con.up.map(c => ({ ...c, side: "up" }))];
      refreshHighlights();
    },
    setHoverConnections(src, con) {
      hoverCon = src ? { src, list: [...con.down, ...con.up] } : null;
      refreshHighlights();
    },
    focusLayer() {},
    setLayout(cells) {
      layoutCells = cells;
      this.setMarks(lastMarks);
      for (let l = 0; l < L; l++) for (let n = 0; n < N; n++) {
        const p = neuronPos(l, n), k = (l * N + n) * 3;
        pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeBoundingSphere();
      buildWeb();
      refreshHighlights();
      chatSceneFocus.rebuild();
    },
    // edges: Int16Array, 6 per link (src layer, src n, dst layer, dst n, 10 * z * sign, hop), or null to hide
    setWeb(edges) { webEdges = edges; buildWeb(); refreshHighlights(); },
    enterLayer, exitLayer, viewLayer, setNotes,
    // centre the view on a neuron, keeping the zoom unless it is wider than a few layers' worth
    focusNeuron(layer, n) { if (layerMode === null) flyTo(neuronPos(layer, n), Math.min(curDist(), homeDist * 0.35)); },
    // fly close to one neuron, keeping the current viewing direction
    flyToNeuron(layer, n, closeness = 0.22) { flyTo(neuronPos(layer, n), homeDist * closeness); },
    get layerMode() { return layerMode; },
    home() { flyTo(home.target, homeDist, home.dir); },
    setMarks(marks) {
      lastMarks = marks;
      const p = [], c = [], up = PAL.up, down = PAL.down;
      for (const m of marks) {
        const v = neuronPos(m.layer, m.n), k = attenuate(m.sign === "-" ? down : up, Math.max(0.15, m.w ?? 1));
        p.push(v.x, v.y, v.z); c.push(k.r, k.g, k.b);
      }
      markGeo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      markGeo.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
      render();
    },
    setInsets(left, right) { insets.left = left; insets.right = right; resize(); },
    hover(layer, n) { hovered = layer == null ? null : { layer, n }; refreshHighlights(); },
    debug() { const tv = controls.target.clone().project(camera); return { tgtScreenX: +((tv.x + 1) / 2).toFixed(3), cam: camera.position.toArray().map(v => +v.toFixed(2)), tgt: controls.target.toArray().map(v => +v.toFixed(2)), selected, hovered, n: connections.length, hover: hoverCon ? hoverCon.list.length : 0, dist: curDist(), homeDist, w: canvas.clientWidth, h: canvas.clientHeight, insets }; },
    render,
    dispose() {
      disposed = true; chatSceneFocus.dispose(); window.removeEventListener(SCENE_COLOR_EVENT, recolor); window.removeEventListener("storage", onColorStorage); themeObserver.disconnect(); flight++; lifetime.abort(); resizeObserver.disconnect(); controls.dispose();
      const resources = new Set();
      scene.traverse(object => {
        if (object.geometry) resources.add(object.geometry);
        for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
          resources.add(material);
          for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
        }
      });
      for (const resource of resources) resource.dispose();
      renderer.dispose(); labelsDiv.replaceChildren();
    },
  };
  return api;

}
