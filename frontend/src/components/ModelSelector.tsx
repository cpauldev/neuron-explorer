import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/store";
import { useExplorer } from "../context";
import { ChoiceSelect } from "./choice-select";
import { GenerationLoadingState } from "./loading-state";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

type Catalog = {
  models: { id: string; model: string; revision: string | null }[];
  current: string;
  generation: string;
  phase: "idle" | "loading";
  target: string | null;
  error: string | null;
};

export function modelOptions(models: Catalog["models"]) {
  return models.map((item) => {
    const shortName = item.model.split("/").at(-1)!;
    const ambiguousName = models.some(
      (other) =>
        other.model !== item.model &&
        other.model.split("/").at(-1) === shortName,
    );
    const multipleVersions =
      models.filter((other) => other.model === item.model).length > 1;
    return {
      value: item.id,
      label: `${ambiguousName ? item.model : shortName}${multipleVersions ? ` · ${item.revision?.slice(0, 7) || "main"}` : ""}`,
      title: `${item.model}\nRevision: ${item.revision || "main"}`,
    };
  });
}

export function ModelSelector() {
  const [s] = useExplorer(["index"]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  const refreshCatalog = useCallback(() => {
    const now = Date.now();
    // Opening the menu and returning to the tab often happen together.
    if (now - lastRefresh.current < 10000) return;
    lastRefresh.current = now;
    setRefresh((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let force = refresh > 0;
    async function read() {
      try {
        const next = await api<Catalog>(
          `/api/models${force ? "?refresh=true" : ""}`,
          undefined,
          { signal: controller.signal },
        );
        force = false;
        if (controller.signal.aborted) return;
        setCatalog(next);
        setError(next.error || "");
        if (s.index.generation && next.generation !== s.index.generation) {
          history.replaceState(null, "", location.pathname);
          location.reload();
          return;
        }
        if (next.phase !== "idle") timer = setTimeout(read, 1000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError((e as Error).message);
          timer = setTimeout(read, 3000);
        }
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, s.index.generation]);
  const switching = pending || catalog?.phase === "loading";
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible" && !switching)
        refreshCatalog();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refreshCatalog, switching]);
  const options = catalog
    ? modelOptions(catalog.models)
    : [
        {
          value: "",
          label: s.index.model?.split("/").at(-1) || "Local model",
          title: s.index.model,
        },
      ];
  const selected = options.find((item) => item.value === catalog?.current);
  async function select(id: string) {
    setError("");
    setPending(true);
    try {
      await api("/api/models", { id });
      setCatalog((current) =>
        current ? { ...current, phase: "loading", target: id } : current,
      );
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="relative flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <ChoiceSelect
              aria-label="Model"
              className="model-selector-trigger border-transparent bg-transparent text-sm text-muted-foreground shadow-none"
              value={catalog?.current || ""}
              disabled={!catalog || switching}
              options={options}
              onValueChange={select}
              onOpenChange={(open) => {
                if (open && !switching) refreshCatalog();
              }}
            />
          }
        />
        <TooltipContent className="max-w-sm whitespace-pre-line break-all">
          {selected?.title || s.index.model}
        </TooltipContent>
      </Tooltip>
      {error && (
        <p
          role="alert"
          className="absolute top-full left-0 z-50 mt-2 w-80 rounded-lg border bg-popover p-3 text-xs text-destructive shadow-md"
        >
          {error}
        </p>
      )}
      <Dialog open={Boolean(switching)}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="max-w-sm"
        >
          <DialogTitle className="sr-only">Switching model</DialogTitle>
          <GenerationLoadingState
            role="status"
            aria-live="polite"
            className="py-6"
            label={`Loading ${
              catalog?.models
                .find((item) => item.id === catalog.target)
                ?.model.split("/")
                .at(-1) || "model"
            }…`}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
