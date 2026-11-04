import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BotIcon } from "lucide-react";

/** The DOM-projected scene label uses the same Lucide icon as the React UI. */
export function mountSceneLabelIcon(container: HTMLElement) {
  const root = createRoot(container);
  root.render(createElement(BotIcon, { size: 14, "aria-hidden": true }));
  return () => queueMicrotask(() => root.unmount());
}
