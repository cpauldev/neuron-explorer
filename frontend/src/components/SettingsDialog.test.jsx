import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi, json } from "../test-helpers";
import { Toolbar } from "./Toolbar";
import { ThemeProvider } from "./theme-provider";
import { SceneColorSettings } from "./SceneColorSettings";
import { sceneColors } from "../../../explorer/static/scene-colors.js";
import { AssistantPanel } from "../assistant/AssistantPanel";
import {
  explorer,
  assistant,
  wrap,
  openAssistantSettings,
} from "./ui-test-helpers";

it("edits scene colors inline without a preset popover and rejects duplicate colors", async () => {
  wrap(<SceneColorSettings />);
  expect(screen.getByRole("heading", { name: "Scene colors" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Scene colors" })).toBeNull();
  const hex = screen.getByRole("textbox", { name: "Background hex color" });
  expect(
    screen.queryByRole("group", { name: "Background presets" }),
  ).toBeNull();
  expect(screen.getByLabelText("Background color").type).toBe("color");
  fireEvent.change(hex, { target: { value: "#123456" } });
  fireEvent.blur(hex);
  const scheme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  expect(sceneColors(scheme).bg).toBe("#123456");
  fireEvent.change(hex, { target: { value: sceneColors(scheme).idle } });
  fireEvent.blur(hex);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(sceneColors(scheme).bg).toBe("#123456");
});

it("renders real assistant-ui messages, restores its composer and changes providers", async () => {
  assistant.actions.start();
  assistant.actions.draft("Claude draft");
  explorer.actions.openAssistant();
  assistant.set({
    messages: [
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        metadata: { custom: { original: "Hello", shown: "Hello", files: [] } },
      },
      {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "**Answer** with `code`" }],
        status: { type: "complete", reason: "stop" },
        metadata: { custom: {} },
      },
    ],
  });
  wrap(<AssistantPanel active />);
  expect(await screen.findByText("Answer")).toBeTruthy();
  expect(screen.getByText("code")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(
      "Claude draft",
    ),
  );
  const user = userEvent.setup();
  await openAssistantSettings();
  await user.click(
    screen.getByRole("combobox", { name: "Assistant provider" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Codex", exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(""),
  );
  fireEvent.change(screen.getByLabelText("Assistant message"), {
    target: { value: "Codex draft" },
  });
  expect(assistant.getSnapshot().draft).toBe("Codex draft");
  await openAssistantSettings();
  await user.click(
    screen.getByRole("combobox", { name: "Assistant provider" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Claude", exact: true }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Assistant message").value).toBe(
      "Claude draft",
    ),
  );
});

it("selects a discovered model in settings and passes it to the backend", async () => {
  const fetcher = mockApi({
    "/api/agent/models": () =>
      json({
        models: [
          { id: "default", name: "CLI default" },
          { id: "test-model", name: "Discovered model" },
        ],
      }),
    "/api/agent/send": () => json({ chat: "model-choice", cursor: 0 }),
    "/api/agent/events": () =>
      new Response(JSON.stringify({ seq: 1, t: "done" }) + "\n"),
  });
  wrap(<AssistantPanel active />);
  await openAssistantSettings();
  const picker = screen.getByRole("combobox", { name: "Assistant model" });
  await waitFor(() => expect(picker.disabled).toBe(false));
  const user = userEvent.setup();
  await user.click(picker);
  await user.click(
    await screen.findByRole("option", {
      name: "Discovered model",
      exact: true,
    }),
  );
  expect(assistant.getSnapshot().model).toBe("test-model");
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  fireEvent.change(screen.getByLabelText("Assistant message"), {
    target: { value: "Use the selected model" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send message", exact: true }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === "/api/agent/send")).toBe(
      true,
    ),
  );
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url === "/api/agent/send")[1].body,
    ).model,
  ).toBe("test-model");
});

it("consolidates file access in settings and does not silently expand access", async () => {
  wrap(<AssistantPanel active />);
  expect(
    screen.queryByRole("radiogroup", { name: "Assistant file access" }),
  ).toBe(null);
  await openAssistantSettings();
  expect(
    screen.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("radio", { name: /Project only/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(assistant.getSnapshot().access).toBe("project");
  fireEvent.click(
    screen.getByRole("radio", { name: /Project \+ home folder/ }),
  );
  expect(assistant.getSnapshot().access).toBe("home");
});

it("closes settings by keyboard without changing the assistant draft", async () => {
  assistant.set({ draft: "Keep my question" });
  wrap(<AssistantPanel active />);
  const user = userEvent.setup();
  await openAssistantSettings();
  expect(
    await screen.findByRole("combobox", { name: "Assistant model" }),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(assistant.getSnapshot().draft).toBe("Keep my question");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Settings", exact: true }),
  );
});

it("opens all preferences from the toolbar and applies appearance and visualization choices", async () => {
  const user = userEvent.setup();
  wrap(
    <ThemeProvider>
      <Toolbar />
    </ThemeProvider>,
  );
  expect(screen.queryByRole("combobox", { name: "Color theme" })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Settings", exact: true }),
  );
  await user.click(screen.getByRole("combobox", { name: "Color theme" }));
  await user.click(screen.getByRole("option", { name: "Light", exact: true }));
  expect(document.documentElement.classList.contains("light")).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "Visualization", exact: true }),
  );
  const before = explorer.getSnapshot().webOn;
  await user.click(screen.getByRole("switch", { name: "Show connections" }));
  expect(explorer.getSnapshot().webOn).toBe(!before);
  await user.click(screen.getByRole("combobox", { name: "Color by" }));
  await user.click(
    await screen.findByRole("option", { name: "Prompt", exact: true }),
  );
  expect(explorer.getSnapshot().colorBy).toBe("prompt");
  await user.click(screen.getByRole("button", { name: "Chat", exact: true }));
  expect(
    screen.getByRole("combobox", { name: "Assistant provider" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("radiogroup", { name: "Assistant file access" }),
  ).toBeTruthy();
});

it("keeps assistant preferences locked during replies, recording, and uploads", async () => {
  const user = userEvent.setup();
  wrap(<Toolbar />);
  await openAssistantSettings();
  for (const patch of [
    { busy: true },
    { busy: false, dictating: true },
    { dictating: false, pending: [{ name: "uploading" }] },
  ]) {
    act(() => assistant.set(patch));
    expect(
      screen.getByRole("combobox", { name: "Assistant provider" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("combobox", { name: "Assistant model" }).disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("radio", { name: /Project only/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  }
});
