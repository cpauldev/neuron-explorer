import { useState } from "react";
import {
  BrainCircuitIcon,
  MessageSquareIcon,
  PanelRightIcon,
  SearchIcon,
  Loader2Icon,
  CircleAlertIcon,
} from "lucide-react";
import { useExplorer } from "../context";
import { useWorkspaceLayout } from "../lib/workspace";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./ui/input-group";
import { Button } from "./ui/button";
import { useAssistantActivity } from "../assistant/activity";

export function Toolbar() {
  const [s, a] = useExplorer(["index", "arch"]);
  const layout = useWorkspaceLayout();
  const activity = useAssistantActivity();
  const [unit, setUnit] = useState("");
  const [error, setError] = useState("");
  return (
    <header className="app-toolbar">
      <div className="app-identity">
        <BrainCircuitIcon
          className="size-5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <h1 className="text-sm font-semibold">Neuron Explorer</h1>
          <p
            className="max-w-56 truncate text-xs text-muted-foreground"
            title={s.index.model}
          >
            {s.index.model?.split("/").at(-1) || "Local model"}
          </p>
        </div>
      </div>
      <form
        className="unit-navigation"
        aria-label="Go to unit"
        onSubmit={(event) => {
          event.preventDefault();
          const match = /^L?\s*(\d+)[\s,\/]+([Nh])?\s*(\d+)$/i.exec(
            unit.trim(),
          );
          if (match) {
            const layer = Number(match[1]),
              n = Number(match[3]),
              kind = match[2]?.toLowerCase() === "h" ? "head" : "neuron";
            if (
              kind === "head" ? a.validHead(layer, n) : a.validNeuron(layer, n)
            ) {
              setError("");
              a.safe(a.select(layer, n, kind));
              return;
            }
          }
          setError(
            `Use a valid unit, such as L7 N1870 or L7 h3. Layers range from 0 to ${s.arch.n_layers - 1}.`,
          );
        }}
      >
        <label className="sr-only" htmlFor="jump">
          Go to neuron or head
        </label>
        <InputGroup>
          <InputGroupInput
            id="jump"
            name="unit"
            value={unit}
            onChange={(event) => {
              setUnit(event.target.value);
              setError("");
            }}
            placeholder="Go to L7 N1870…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "unit-error" : undefined}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="submit"
              size="icon-xs"
              aria-label="Go to unit"
            >
              <SearchIcon aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {error ? (
          <p
            id="unit-error"
            role="alert"
            className="unit-error text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </form>
      <nav className="workspace-actions" aria-label="Workspace panels">
        <Button
          variant={layout.assistant ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={layout.assistant}
          aria-controls="assistant-sidebar"
          title={
            activity === "approval"
              ? "Command approval requested"
              : activity === "working"
                ? "Assistant is working"
                : undefined
          }
          onClick={() => a.togglePanel("assistant", layout.assistant)}
        >
          {activity === "approval" ? (
            <CircleAlertIcon aria-hidden="true" />
          ) : activity === "working" ? (
            <Loader2Icon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <MessageSquareIcon aria-hidden="true" />
          )}
          Assistant
        </Button>
        <Button
          variant={layout.tools ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={layout.tools}
          aria-controls="tools-sidebar"
          onClick={() => a.togglePanel("tools", layout.tools)}
        >
          <PanelRightIcon aria-hidden="true" />
          Tools
        </Button>
      </nav>
    </header>
  );
}

export function WorkspaceNotice() {
  const [s] = useExplorer(["status"]);
  if (!s.status) return null;
  return (
    <div className="workspace-notice" role="status" aria-live="polite">
      {s.status}
    </div>
  );
}
export function AssistantApprovalNotice() {
  const [, a] = useExplorer([]);
  const activity = useAssistantActivity();
  if (activity !== "approval") return null;
  return (
    <div className="assistant-status" role="status">
      <Button variant="link" size="xs" onClick={a.openAssistant}>
        Review command approval
      </Button>
    </div>
  );
}
