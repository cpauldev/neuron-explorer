import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, mockApi } from "../test-helpers";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { assistant, wrap } from "./ui-test-helpers";

const saved = {
  chat: "saved",
  provider: "codex",
  title: "Circuit investigation",
  updated: 1,
};

async function requestDelete() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: `More options for ${saved.title}` }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete", exact: true }),
  );
  return user;
}

it("requires confirmation and deletes a saved chat through the official adapter", async () => {
  const fetcher = mockApi({ "/api/agent/delete": () => json({ ok: true }) });
  assistant.set({ historyOpen: true, history: [saved] });
  wrap(<AssistantPanel active />);
  let user = await requestDelete();
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/delete")).toBe(
    false,
  );
  user = await requestDelete();
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
      exact: true,
    }),
  );
  await waitFor(() => expect(assistant.getSnapshot().history).toEqual([]));
  expect(
    screen.queryByRole("button", { name: saved.title, exact: true }),
  ).toBeNull();
  const [, request] = fetcher.mock.calls.find(
    ([url]) => url === "/api/agent/delete",
  );
  expect(JSON.parse(request.body)).toEqual({
    chat: saved.chat,
    provider: saved.provider,
  });
});

it("keeps history and displays a failed deletion without claiming success", async () => {
  mockApi({
    "/api/agent/delete": () =>
      json({ error: "Stop this chat before deleting it." }),
  });
  assistant.set({ historyOpen: true, history: [saved] });
  wrap(<AssistantPanel active />);
  const user = await requestDelete();
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
      exact: true,
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Stop this chat before deleting it.",
  );
  expect(assistant.getSnapshot().history).toEqual([saved]);
});

it("starts a blank chat after deleting the current one and removes its saved draft", async () => {
  mockApi({ "/api/agent/delete": () => json({ ok: true }) });
  assistant.set({
    chat: saved.chat,
    provider: "codex",
    historyOpen: true,
    history: [saved],
    draft: "Unsent draft",
  });
  localStorage.setItem(
    "explorer.draft.saved",
    JSON.stringify({ draft: "Unsent draft" }),
  );
  wrap(<AssistantPanel active />);
  const user = await requestDelete();
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
      exact: true,
    }),
  );
  await waitFor(() => expect(assistant.getSnapshot().chat).toBeNull());
  expect(assistant.getSnapshot().draft).toBe("");
  expect(assistant.getSnapshot().messages).toEqual([]);
  expect(JSON.parse(localStorage.getItem("explorer.draft.saved"))).toBeNull();
  expect(
    JSON.parse(localStorage.getItem("explorer.agent.codex")).chat,
  ).toBeNull();
});

it("disables deletion for a running saved chat", async () => {
  assistant.set({ historyOpen: true, history: [{ ...saved, running: true }] });
  wrap(<AssistantPanel active />);
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: `More options for ${saved.title}` }),
    );
  expect(
    (
      await screen.findByRole("menuitem", { name: "Delete", exact: true })
    ).getAttribute("data-disabled"),
  ).not.toBeNull();
});
