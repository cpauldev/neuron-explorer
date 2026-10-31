import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorState } from "./error-state";

afterEach(cleanup);

it("keeps a long provider error intact and retry keyboard-operable", async () => {
  const retry = vi.fn();
  const detail =
    "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again later.";
  render(
    <ErrorState
      title="Response failed"
      detail={detail}
      retrying={false}
      onRetry={retry}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(detail);
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Retry" }),
  );
  await user.keyboard("{Enter}");
  expect(retry).toHaveBeenCalledTimes(1);
});

it("shows retry progress without offering another retry", () => {
  render(
    <ErrorState
      title="Response failed"
      detail="Limit reached"
      retrying
      onRetry={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Retrying");
  expect(screen.queryByRole("button", { name: "Retry" })).toBe(null);
});
