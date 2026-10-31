import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tokens } from "./explorer-ui";
import { TooltipProvider } from "./ui/tooltip";

afterEach(cleanup);

it("explains byte fragments without offering a search for their display label", async () => {
  const search = vi.fn();
  render(
    <TooltipProvider>
      <Tokens values={["bytes:E4 BD", "你好"]} onSearch={search} />
    </TooltipProvider>,
  );
  expect(screen.getByText("Byte fragment")).toBeTruthy();
  expect(screen.queryByText("bytes:E4 BD")).toBe(null);
  expect(screen.queryByRole("button", { name: "bytes:E4 BD" })).toBe(null);
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement.getAttribute("aria-label")).toBe(
    "Byte fragment: E4 BD",
  );
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  expect(screen.getByText("UTF-8 bytes: E4 BD")).toBeTruthy();
  expect(search).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "你好" }));
  expect(search).toHaveBeenCalledWith("你好");
});

it("keeps unknown tokenizer fragments distinct from byte fragments", async () => {
  render(
    <TooltipProvider>
      <Tokens values={["token:123 (raw_piece)"]} />
    </TooltipProvider>,
  );
  expect(screen.getByText("Token fragment")).toBeTruthy();
  await userEvent.tab();
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  expect(screen.getByText("token:123 (raw_piece)")).toBeTruthy();
});
