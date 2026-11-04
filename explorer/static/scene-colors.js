export const SCENE_COLOR_KEY = "neuron-explorer-scene-colors-v1";
export const SCENE_COLOR_EVENT = "neuron-explorer-scene-colors";
export function coverageColors(scheme) {
  return { saved: scheme === 'dark' ? '#4ade80' : '#15803d', working: sceneColors(scheme).hi };
}
export const SCENE_ROLES = [
  { key: "bg", label: "Background", group: "Scene" },
  { key: "idle", label: "Neurons", group: "Scene" },
  { key: "slab", label: "Linear attention", group: "Scene" },
  { key: "slabFull", label: "Full attention", group: "Scene" },
  { key: "named", label: "Selection", group: "Scene" },
  { key: "hi", label: "Activity", group: "Scene" },
  { key: "up", label: "Positive links", group: "Connections" },
  { key: "down", label: "Negative links", group: "Connections" },
  { key: "q", label: "Query links", group: "Connections" },
  { key: "k", label: "Key links", group: "Connections" },
  { key: "link", label: "Value / output links", group: "Connections" },
];
// Neutral anatomy; conventional status colors for signed relationships and activity.
// Attention roles share a cool family without borrowing positive/negative status hues.
const defaults = {
  light: {bg:"#f8fafc",idle:"#64748b",slab:"#94a3b8",slabFull:"#475569",named:"#3b82f6",hi:"#f59e0b",up:"#22c55e",down:"#ef4444",q:"#0ea5e9",k:"#818cf8",link:"#06b6d4"},
  dark: {bg:"#0b1220",idle:"#64748b",slab:"#7387a3",slabFull:"#a8b8cf",named:"#60a5fa",hi:"#fbbf24",up:"#4ade80",down:"#f87171",q:"#38bdf8",k:"#a5b4fc",link:"#22d3ee"},
};
// An untouched saved default from the previous release should receive new defaults.
// Any customized palette is preserved as a whole.
const previousDefaults = {
  light: {bg:"#f8faff",idle:"#4285f4",slab:"#00897b",slabFull:"#f57c00",named:"#174ea6",hi:"#e37400",up:"#e59b00",down:"#d93025",q:"#188038",k:"#9334e6",link:"#0097c4"},
  dark: {bg:"#111722",idle:"#4285f4",slab:"#26c6b0",slabFull:"#ff9800",named:"#ffffff",hi:"#ffe066",up:"#fbbc04",down:"#ff625a",q:"#55d98a",k:"#c58af9",link:"#4dd0ff"},
};
const previousLightDefaults = {bg:"#f8fafc",idle:"#64748b",slab:"#94a3b8",slabFull:"#475569",named:"#2563eb",hi:"#d97706",up:"#15803d",down:"#dc2626",q:"#0284c7",k:"#4f46e5",link:"#0891b2"};
export function normalizeSceneColor(value) {
  if (typeof value !== "string") return null;
  let hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(hex)) hex = "#" + [...hex.slice(1)].map(c => c + c).join("");
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}
function savedColors() {
  try { return JSON.parse(localStorage.getItem(SCENE_COLOR_KEY) || "{}"); } catch { return {}; }
}
export function sceneColors(scheme) {
  const colors = { ...defaults[scheme] };
  const saved = savedColors()?.[scheme];
  // Accept only complete, unique, known role values, even if storage was edited externally.
  if (saved && typeof saved === "object") {
    if (SCENE_ROLES.every(({key}) => normalizeSceneColor(saved[key]) === previousDefaults[scheme][key])) return colors;
    if (scheme === "light" && SCENE_ROLES.every(({key}) => normalizeSceneColor(saved[key]) === previousLightDefaults[key])) return colors;
    const candidate = Object.fromEntries(SCENE_ROLES.map(({key}) => [key, normalizeSceneColor(saved[key]) || colors[key]]));
    if (new Set(Object.values(candidate)).size === SCENE_ROLES.length) return candidate;
  }
  return colors;
}
export function setSceneColor(scheme, key, value) {
  const color = normalizeSceneColor(value);
  if (!color) return "Enter a hex color, such as #4285f4.";
  if (!SCENE_ROLES.some(role => role.key === key)) return "Unknown scene color.";
  const colors = sceneColors(scheme);
  const duplicate = SCENE_ROLES.find(role => role.key !== key && colors[role.key] === color);
  if (duplicate) return `Already used by ${duplicate.label.toLowerCase()}. Choose another color.`;
  const saved = savedColors() || {};
  try { localStorage.setItem(SCENE_COLOR_KEY, JSON.stringify({...saved,[scheme]:{...colors,[key]:color}})); }
  catch { return "Could not save colors in this browser."; }
  window.dispatchEvent(new Event(SCENE_COLOR_EVENT));
  return null;
}
export function resetSceneColors(scheme) {
  const saved = savedColors() || {};
  try { localStorage.setItem(SCENE_COLOR_KEY, JSON.stringify({...saved,[scheme]:defaults[scheme]})); }
  catch { return "Could not save colors in this browser."; }
  window.dispatchEvent(new Event(SCENE_COLOR_EVENT));
  return null;
}
