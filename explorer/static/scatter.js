const PROMPT_COLORS = { who: "#e07b5f", snake: "#5fb37a", orange: "#e0b45f", free: "#8f7ae0" };
const KIND_COLORS = { neuron: "#9a9a9a", random: "#38c8ff", baseline: "#ffffff" };

function hashColor(n) {
  const h = (n * 2654435761) % 360;
  return `hsl(${h}, 55%, 60%)`;
}
function doseColor(d) {
  if (d === 0) return "#ffffff";
  const t = Math.min(1, Math.abs(d) / 1.0);
  return d > 0 ? `rgba(255,181,71,${0.35 + 0.65 * t})` : `rgba(255,79,154,${0.35 + 0.65 * t})`;
}

export function createScatter(canvas, cb) {
  const lifetime = new AbortController();
  const listen = (type, fn, options = {}) => canvas.addEventListener(type, fn, { ...options, signal: lifetime.signal });
  const ctx = canvas.getContext("2d");
  let data = null, colorBy = "neuron", sel = null, hoverIdx = -1;
  let view = { x: 0, y: 0, k: 1 };
  let insets = { left: 404, right: 0 };
  const dpr = Math.min(devicePixelRatio, 2);

  function size() {
    canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; draw();
  }
  const resizeObserver = new ResizeObserver(size);
  resizeObserver.observe(canvas);

  const pad = 60;
  function toScreen(i) {
    const narrow = innerWidth <= 760, left = narrow ? 0 : insets.left, right = narrow ? 0 : insets.right;
    const w = Math.max(20, canvas.clientWidth - 2 * pad - left - right), h = Math.max(20, canvas.clientHeight - 2 * pad - 44), s = Math.min(w, h);
    const ox = left + pad + (w - s) / 2, oy = 44 + pad + (h - s) / 2;
    return [(ox + data.x[i] * s) * view.k + view.x, (oy + (1 - data.y[i]) * s) * view.k + view.y];
  }
  function color(i) {
    if (data.kind[i] === "baseline") return "#ffffff";
    if (colorBy === "prompt") return PROMPT_COLORS[data.prompt[i]] || "#888";
    if (colorBy === "dose") return doseColor(data.dose[i]);
    if (colorBy === "kind") return KIND_COLORS[data.kind[i]];
    return data.kind[i] === "random" ? "#3a3a3a" : hashColor(data.neuron[i]);
  }
  function isSel(i) { return sel && sel.layer === data.layer && data.kind[i] === "neuron" && data.neuron[i] === sel.n; }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!data || !data.x) return;
    const r = Math.max(1.6, Math.min(4, 2.2 * Math.sqrt(view.k)));
    const n = data.x.length;
    const selected = sel && sel.layer === data.layer;
    ctx.globalAlpha = selected ? 0.25 : 0.85;
    for (let i = 0; i < n; i++) {
      if (isSel(i)) continue;
      const [x, y] = toScreen(i);
      ctx.fillStyle = color(i); ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    if (selected) {
      ctx.globalAlpha = 1;
      for (let i = 0; i < n; i++) if (isSel(i)) {
        const [x, y] = toScreen(i);
        ctx.fillStyle = doseColor(data.dose[i]);
        ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, 7); ctx.fill();
      }
    }
    if (hoverIdx >= 0) {
      const [x, y] = toScreen(hoverIdx);
      ctx.globalAlpha = 1; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function nearest(mx, my) {
    let best = -1, bd = 100;
    for (let i = 0; i < data.x.length; i++) {
      const [x, y] = toScreen(i), d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  canvas.style.cursor = "grab";
  let drag = null, moved = false;
  listen("pointerdown", e => { if (e.button !== 0) return; drag = [e.clientX, e.clientY, view.x, view.y]; moved = false; });
  addEventListener("pointerup", e => {
    if (drag && !moved && data && e.target === canvas) {
      const r = canvas.getBoundingClientRect(), i = nearest(e.clientX - r.left, e.clientY - r.top);
      if (i >= 0) cb.onPick(i);
    }
    drag = null;
    canvas.style.cursor = hoverIdx >= 0 ? "pointer" : "grab";
  }, { signal: lifetime.signal });
  listen("pointercancel", () => { drag = null; });
  listen("pointermove", e => {
    if (!data || !data.x) return;
    if (drag) {
      const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
      if (Math.hypot(dx, dy) > 3) moved = true;
      if (moved) { canvas.style.cursor = "grabbing"; view.x = drag[2] + dx; view.y = drag[3] + dy; draw(); return; }
    }
    const r = canvas.getBoundingClientRect();
    const i = nearest(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = i >= 0 ? "pointer" : "grab";
    if (i !== hoverIdx) { hoverIdx = i; draw(); cb.onHover(i, e.clientX, e.clientY); }
    else if (i >= 0) cb.onHover(i, e.clientX, e.clientY);
  });
  listen("pointerleave", () => { hoverIdx = -1; draw(); cb.onHover(-1); });
  listen("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015), k = Math.max(0.5, Math.min(40, view.k * f)), ff = k / view.k;
    view.x = mx - (mx - view.x) * ff; view.y = my - (my - view.y) * ff; view.k = k; draw();
  }, { passive: false });

  return {
    setData(d) { data = d; view = { x: 0, y: 0, k: 1 }; hoverIdx = -1; draw(); },
    setColorBy(c) { colorBy = c; draw(); },
    setInsets(left, right) { insets = { left, right }; draw(); },
    select(layer, n) { sel = n == null ? null : { layer, n }; draw(); },
    draw,
    get data() { return data; },
    dispose() { lifetime.abort(); resizeObserver.disconnect(); data = null; },
  };
}
