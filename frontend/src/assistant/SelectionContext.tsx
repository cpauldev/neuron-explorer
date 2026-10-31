import { useAuiState } from "@assistant-ui/react";
import { XIcon, FocusIcon } from "lucide-react";
import { useAssistant, useExplorer } from "../context";
import type { SelectionContext } from "../types";
import { Button } from "../components/ui/button";
import { refLabel } from "../lib/store";

export function UnitLink({
  unit,
  children,
}: {
  unit: SelectionContext;
  children?: React.ReactNode;
}) {
  const [, a] = useExplorer([]);
  const href = `#L${unit.layer}/${unit.kind === "head" ? "h" : "N"}${unit.n}`;
  return (
    <a
      href={href}
      className="text-primary underline underline-offset-4"
      onClick={(event) => {
        if (
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        a.safe(
          a.select(unit.layer, unit.n, unit.kind, { agent: true, fly: false }),
        );
      }}
    >
      {children || refLabel(unit)}
    </a>
  );
}

export function ComposerSelection() {
  const [e] = useExplorer(["focus"]);
  const [s, a] = useAssistant(["includeSelection", "busy"]);
  if (!e.focus || !["neuron", "head"].includes(e.focus.kind)) return null;
  const unit = e.focus as SelectionContext;
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-2 pt-1 text-xs"
      data-slot="selection-context"
    >
      {s.includeSelection ? (
        <>
          <FocusIcon
            className="text-muted-foreground size-3.5"
            aria-hidden="true"
          />
          <span className="text-muted-foreground">Context</span>
          <UnitLink unit={unit} />
          <button
            type="button"
            aria-label="Remove selected unit from message context"
            className="text-muted-foreground rounded p-1 hover:bg-accent"
            onClick={() => a.includeSelection(false)}
          >
            <XIcon className="size-3" />
          </button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => a.includeSelection(true)}
        >
          Include {refLabel(unit)}
        </Button>
      )}
    </div>
  );
}

export function SentContext() {
  const context = useAuiState((s) => s.message.metadata.custom.context) as
    SelectionContext | undefined;
  return context ? (
    <div className="text-muted-foreground col-span-full flex justify-end gap-1 text-xs">
      Context: <UnitLink unit={context} />
    </div>
  ) : null;
}
