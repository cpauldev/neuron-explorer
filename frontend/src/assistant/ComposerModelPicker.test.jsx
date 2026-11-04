import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assistant, wrap } from "../components/ui-test-helpers";
import { json, mockApi } from "../test-helpers";
import { ComposerModelPicker } from "./ComposerModelPicker";

it("switches provider and model together and preserves each provider's draft", async () => {
  mockApi({
    "/api/agent/models": (url) =>
      json({
        models: [
          { id: "default", name: "CLI default" },
          {
            id: `${url.searchParams.get("provider")}-test`,
            name: `${url.searchParams.get("provider")} test model`,
          },
        ],
      }),
  });
  const user = userEvent.setup();
  assistant.actions.draft("Claude draft");
  wrap(<ComposerModelPicker />);
  await user.click(screen.getByRole("button", { name: /Chat model:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "codex test model" }),
  );
  await waitFor(() => expect(assistant.getSnapshot().provider).toBe("codex"));
  expect(assistant.getSnapshot().model).toBe("codex-test");
  expect(assistant.getSnapshot().draft).toBe("");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  act(() => assistant.actions.draft("Codex draft"));
  await user.click(screen.getByRole("button", { name: /Chat model:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "claude test model" }),
  );
  await waitFor(() => expect(assistant.getSnapshot().provider).toBe("claude"));
  expect(assistant.getSnapshot().model).toBe("claude-test");
  expect(assistant.getSnapshot().draft).toBe("Claude draft");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(screen.getByRole("button", { name: /Chat model:/ }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("disables switching while a turn is running", () => {
  assistant.set({ busy: true });
  wrap(<ComposerModelPicker />);
  expect(screen.getByRole("button", { name: /Chat model:/ }).disabled).toBe(
    true,
  );
});
