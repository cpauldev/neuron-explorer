/** Shared signed-web geometry for user selection and temporary chat focus. */
export function webGeometry(
  edges,
  selection,
  { count, position, palette, alphaBase = 0.72, decay = 0.85 },
) {
  const m = edges.length / 6,
    p = new Float32Array(m * 6),
    c = new Float32Array(m * 6),
    alpha = new Float32Array(m);
  let zhi = 1;
  for (let i = 0; i < m; i++) zhi = Math.max(zhi, Math.abs(edges[i * 6 + 4]));
  // a line is "through" when the web continues past both ends: its writer is read into by another drawn line (or is
  // the open neuron) and its reader writes on into another (or is the open neuron); dead ends draw dimmer
  const fed = new Set(),
    feeds = new Set(),
    nk = (l, n) => l * count + n;
  for (let i = 0; i < m; i++) {
    const e = edges.subarray(i * 6, i * 6 + 6);
    feeds.add(nk(e[0], e[1]));
    fed.add(nk(e[2], e[3]));
  }
  const root = selection ? nk(selection.layer, selection.n) : -1;
  const touched = new Map();
  for (let i = 0; i < m; i++) {
    const e = edges.subarray(i * 6, i * 6 + 6),
      a = position(e[0], e[1]),
      b = position(e[2], e[3]);
    const k = e[4] > 0 ? palette.up : palette.down;
    const s0 = nk(e[0], e[1]),
      d0 = nk(e[2], e[3]);
    const through =
      (s0 === root || fed.has(s0)) && (d0 === root || feeds.has(d0));
    const al =
      alphaBase *
      (0.6 + (0.4 * Math.abs(e[4])) / zhi) *
      Math.max(0.1, decay ** (Math.abs(e[5]) - 1)) *
      (through ? 1 : 0.08);
    const ink = k;
    alpha[i] = through ? Math.max(0.12, Math.min(0.92, al)) : 0.035;
    p.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    c.set([...ink.toArray(), ...ink.toArray()], i * 6);
    // each touched neuron takes the colour of the hop that first reached it (edges arrive in hop order)
    const key = e[5] > 0 ? e[2] * count + e[3] : e[0] * count + e[1];
    if (!touched.has(key))
      touched.set(key, [e[5] > 0 ? b : a, k, Math.abs(e[5])]);
  }
  // dots too: a neuron the web runs through (read into and out of, or next to the open neuron) at full brightness
  const tp = [],
    tc = [],
    ta = [];
  for (const [id, [v, k, hop]] of touched) {
    const f =
      (fed.has(id) || id === root) && (feeds.has(id) || id === root)
        ? 1
        : 0.08 * 3;
    tp.push(v.x, v.y, v.z);
    tc.push(...k.toArray());
    ta.push(f * Math.max(0.1, 0.8 ** Math.max(0, hop - 1)));
  }
  return {
    positions: p,
    colors: c,
    opacity: alpha,
    pointPositions: tp,
    pointColors: tc,
    pointOpacity: ta,
    fed,
    feeds,
  };
}
