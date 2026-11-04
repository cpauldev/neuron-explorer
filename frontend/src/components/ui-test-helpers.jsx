import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExplorerContext, AssistantContext } from "../context";
import { createExplorer } from "../explorer";
import { createAssistant } from "../assistant/store";
import { indexFixture, mockApi } from "../test-helpers";
import { SettingsDialog } from "./SettingsDialog";
import { AssistantPanel } from "../assistant/AssistantPanel";

export let explorer, assistant;

beforeEach(() => {
  localStorage.clear();
  mockApi();
  explorer = createExplorer(indexFixture);
  assistant = createAssistant(explorer);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  assistant.actions.dispose();
  explorer.actions.dispose();
  vi.unstubAllGlobals();
});

export function wrap(children) {
  return render(
    <ExplorerContext.Provider value={explorer}>
      <AssistantContext.Provider value={assistant}>
        {children}
        {children?.type === AssistantPanel ? <SettingsDialog /> : null}
      </AssistantContext.Provider>
    </ExplorerContext.Provider>,
  );
}

export async function openAssistantSettings() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Settings", exact: true }),
  );
  await user.click(screen.getByRole("button", { name: "Chat", exact: true }));
}
