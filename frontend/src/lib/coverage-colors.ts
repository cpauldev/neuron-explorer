import { useSyncExternalStore } from "react";
import {
  coverageColors,
  SCENE_COLOR_EVENT,
} from "../../../explorer/static/scene-colors.js";

function subscribe(update: () => void) {
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  window.addEventListener(SCENE_COLOR_EVENT, update);
  window.addEventListener("storage", update);
  return () => {
    observer.disconnect();
    window.removeEventListener(SCENE_COLOR_EVENT, update);
    window.removeEventListener("storage", update);
  };
}
function snapshot() {
  return JSON.stringify(
    coverageColors(
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    ),
  );
}
export function useCoverageColors(): { saved: string; working: string } {
  return JSON.parse(useSyncExternalStore(subscribe, snapshot));
}
