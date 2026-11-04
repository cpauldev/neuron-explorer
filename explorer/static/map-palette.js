import { Color } from "three";
import { sceneColors, coverageColors } from "./scene-colors.js";

// Editable semantic roles are the single source of truth; supporting shades are derived.
export function mapPalette(scheme) {
  const colors = sceneColors(scheme);
  const coverage = coverageColors(scheme);
  const tint = (color, amount) => new Color(color).lerp(new Color(colors.bg), amount);
  return {
    ...Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, new Color(color)])),
    label: new Color(scheme === "dark" ? "#b8c4d6" : "#475569"),
    swept: tint(colors.idle, 0.1), wire: tint(colors.idle, 0.4), wireData: new Color(colors.idle),
    slabEdge: new Color(colors.slab), head: new Color(colors.slab),
    slabEdgeFull: new Color(colors.slabFull), headFull: new Color(colors.slabFull),
    lo: tint(colors.hi, 0.4), saved: new Color(coverage.saved),
    working: new Color(coverage.working), pending: tint(colors.idle, 0.6),
  };
}
