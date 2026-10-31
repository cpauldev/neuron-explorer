import { useEffect, useState } from "react";
import type { Architecture } from "../types";
import { useExplorer } from "../context";
import { api } from "../lib/store";
import { Slot } from "./explorer-ui";
import { ChoiceSelect } from "./choice-select";
import { Field, FieldLabel } from "./ui/field";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./ui/collapsible";

const names: Record<string, string> = {
  layout_writes: "Writes layout",
  layout_reads: "Reads layout",
  connections: "Connections",
  lens: "Logit lens",
  steer: "Steering effects",
  activations: "Activation ranges",
};
interface Snapshot {
  id: string;
  model: string;
  revision: string;
  arch: Architecture;
  running: boolean;
  pause_requested: boolean;
  edge_version: string;
  state: {
    status: string;
    stage?: string;
    phase?: string;
    completed_units?: number;
    total_units?: number;
    eta_seconds?: number;
    updated?: number;
    error?: string;
  };
  stages: {
    id: string;
    complete: boolean;
    neurons: number[];
    version: string;
  }[];
  active: { layer: number; start: number; end: number } | null;
}
const duration = (seconds: number) =>
  seconds < 60
    ? `${Math.floor(seconds)}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
function updateAge(timestamp: number) {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  return seconds < 10
    ? "just now"
    : `${seconds < 86400 ? duration(seconds) : `${Math.floor(seconds / 86400)}d`} ago`;
}
function stageProgress(item: Snapshot["stages"][number], snapshot: Snapshot) {
  const { state, arch } = snapshot;
  if (item.id === "steer" || item.id === "lens") {
    return {
      done: item.neurons.reduce((sum, count) => sum + count, 0),
      total: arch.n_layers * arch.inter,
      unit: "neurons",
    };
  }
  if (item.id.startsWith("layout_")) {
    return {
      done: item.neurons.filter((n) => n === arch.inter).length,
      total: arch.n_layers,
      unit: "layers",
    };
  }
  if (state.stage === item.id && state.total_units != null) {
    return {
      done: state.completed_units || 0,
      total: state.total_units,
      unit: item.id === "activations" ? "token batches" : "layer groups",
    };
  }
  return null;
}

export function BuildPanel() {
  const [s, a] = useExplorer(["index", "arch", "layout", "mapReady", "webOn"]);
  const [jobs, setJobs] = useState<{ id: string; model: string }[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [job, setJob] = useState(
    new URLSearchParams(location.search).get("build") || "",
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const [stage, setStage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setJobsLoading(true);
    api<{ jobs: typeof jobs }>("/api/cache-builds", undefined, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setJobs(result.jobs);
        setJob(
          (current) =>
            current ||
            result.jobs.find((j) => j.model === s.index.model)?.id ||
            "",
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setJobsLoading(false);
      });
    return () => controller.abort();
  }, [s.index.model]);
  useEffect(() => {
    if (!job) {
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(null);
    async function poll() {
      try {
        const data = await api<Snapshot>(
          `/api/cache-builds/${encodeURIComponent(job)}`,
          undefined,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setSnapshot(data);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [job]);
  const compatible = Boolean(
    snapshot &&
    snapshot.model === s.index.model &&
    snapshot.arch.n_layers === s.arch.n_layers &&
    snapshot.arch.inter === s.arch.inter &&
    snapshot.arch.hidden === s.arch.hidden &&
    snapshot.revision === s.index.revision,
  );
  // A different model's job must not replace the loaded model with an empty coverage map.
  useEffect(() => {
    if (compatible) a.setAnalysisMode("build");
    else if (snapshot || (!jobsLoading && !job)) a.setAnalysisMode("net");
  }, [compatible, snapshot, jobsLoading, job, a]);
  const shownStage =
    stage ||
    snapshot?.state.stage ||
    snapshot?.stages.find((item) => !item.complete)?.id ||
    snapshot?.stages[0]?.id ||
    "";
  const layoutVersion = snapshot?.stages.find(
    (item) => item.id === `layout_${s.layout}`,
  )?.version;
  useEffect(() => {
    if (s.mapReady)
      a.paintBuild(
        compatible
          ? snapshot?.stages.find((item) => item.id === shownStage)?.neurons ||
              []
          : [],
        compatible && snapshot?.state.stage === shownStage && snapshot.running
          ? snapshot.active
          : null,
      );
  }, [snapshot, shownStage, compatible, s.mapReady, a]);
  useEffect(() => {
    if (!s.mapReady) return;
    if (!compatible || s.layout === "index") {
      a.layoutBuild(null);
      return;
    }
    const controller = new AbortController();
    api<{ cell: string }>(
      `/api/cache-builds/${encodeURIComponent(job)}/layout?kind=${s.layout}`,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        const bytes = Uint8Array.from(atob(data.cell), (c) => c.charCodeAt(0)),
          view = new DataView(bytes.buffer);
        const cells = Int16Array.from({ length: bytes.length / 2 }, (_, i) =>
          view.getInt16(i * 2, true),
        );
        if (!controller.signal.aborted) a.layoutBuild(cells);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [job, s.layout, layoutVersion, compatible, s.mapReady, a]);
  useEffect(() => {
    if (!s.mapReady) return;
    if (!compatible || !snapshot?.edge_version || !s.webOn) {
      a.edgesBuild(null);
      return;
    }
    const controller = new AbortController();
    api<{ edges: number[] }>(
      `/api/cache-builds/${encodeURIComponent(job)}/edges`,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted)
          a.edgesBuild(new Int16Array(data.edges));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [job, snapshot?.edge_version, compatible, s.mapReady, s.webOn, a]);
  async function control(action: "pause" | "resume") {
    setBusy(true);
    try {
      await api(`/api/cache-builds/${encodeURIComponent(job)}/${action}`, {});
      setSnapshot(await api(`/api/cache-builds/${encodeURIComponent(job)}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const state = snapshot?.state,
    running = snapshot?.running;
  const currentStage =
    state?.stage || snapshot?.stages.find((item) => !item.complete)?.id;
  const status =
    !job && !jobsLoading
      ? "No resumable build for the loaded model"
      : jobsLoading
        ? "Loading cache builds…"
        : !jobs.length
          ? "No cache builds"
          : snapshot?.pause_requested && running
            ? "Pausing after checkpoint…"
            : running
              ? "Building"
              : {
                  created: "Ready",
                  paused: "Paused",
                  interrupted: "Interrupted",
                  completed: "Complete",
                  failed: "Failed",
                }[state?.status || ""] || "Connecting…";
  return (
    <div id="cache-build-panel" className="cache-panel">
      <section className="space-y-2 border-b p-4" aria-label="Loaded model">
        <h3 className="text-sm font-medium">
          {s.index.model?.split("/").at(-1) || "Local model"}
        </h3>
        <p className="text-xs text-muted-foreground">
          Loaded model · {s.arch.n_layers} layers ·{" "}
          {s.arch.inter.toLocaleString()} neurons per layer
        </p>
        <p className="text-xs text-muted-foreground">
          Saved steering examples: {Object.keys(s.index.layers).length} of{" "}
          {s.arch.n_layers} layers
        </p>
      </section>
      <div className="wsum space-y-3">
        <Field>
          <FieldLabel htmlFor="cache-build">Build job</FieldLabel>
          <div className="build-controls">
            <ChoiceSelect
              id="cache-build"
              className="min-w-0 flex-1"
              aria-label="Cache build"
              value={job}
              disabled={jobsLoading}
              onValueChange={(value) => {
                setJob(value);
                setStage("");
                setError("");
              }}
              options={[
                {
                  value: "",
                  label: jobsLoading
                    ? "Loading…"
                    : `${s.index.model?.split("/").at(-1) || "Loaded model"} · loaded model`,
                },
                ...jobs.map((j) => ({
                  value: j.id,
                  label: `${j.model}${jobs.filter((other) => other.model === j.model).length > 1 ? ` · ${j.id}` : ""}`,
                })),
              ]}
            />
            {snapshot ? (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !snapshot ||
                  state?.status === "completed" ||
                  Boolean(running && snapshot.pause_requested)
                }
                title={
                  running
                    ? "Pause after the current checkpoint finishes"
                    : "Continue from saved checkpoints"
                }
                onClick={() => void control(running ? "pause" : "resume")}
              >
                {busy ? "Updating…" : running ? "Pause" : "Resume"}
              </Button>
            ) : null}
          </div>
        </Field>
        <div className="build-state dim" role="status" aria-live="polite">
          {status}
        </div>
        {error ? <Slot error>{error}</Slot> : null}
        {!jobsLoading && !jobs.length && !error ? (
          <Slot>Live inspection is available without a build job.</Slot>
        ) : null}
        {snapshot && !compatible ? (
          <Slot>
            This build belongs to a different model or revision. Coverage cannot
            be displayed on the loaded model.
          </Slot>
        ) : null}
      </div>
      <ol className="build-stages">
        {snapshot?.stages.map((item) => {
          const current = item.id === currentStage && !item.complete,
            progress = stageProgress(item, snapshot);
          const saved = progress && progress.done > 0;
          const count = progress
            ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} ${progress.unit}`
            : "";
          const detail = item.complete
            ? "Done"
            : progress && (current || saved)
              ? count
              : current
                ? running
                  ? "Starting…"
                  : status
                : "Pending";
          return (
            <li key={item.id}>
              <Button
                variant={shownStage === item.id ? "secondary" : "ghost"}
                className="h-auto w-full justify-start whitespace-normal py-3 text-left disabled:opacity-100"
                disabled={!compatible}
                aria-pressed={compatible ? shownStage === item.id : undefined}
                aria-current={current ? "step" : undefined}
                title={
                  compatible
                    ? `Show ${names[item.id].toLowerCase()} coverage on the map`
                    : undefined
                }
                onClick={() =>
                  setStage(item.id === currentStage ? "" : item.id)
                }
              >
                <span className="build-step-icon" aria-hidden="true">
                  {item.complete ? "✓" : current && running ? "●" : "○"}
                </span>
                <span className="build-step-name">{names[item.id]}</span>
                <small>{detail}</small>
              </Button>
              {current ? (
                <div className="build-step-progress">
                  <Progress
                    aria-label={`${names[item.id]} progress`}
                    value={progress?.done ?? null}
                    max={progress?.total ?? 100}
                    aria-valuetext={progress ? count : "Preparing stage"}
                  />
                  <div className="build-step-meta">
                    <span>
                      {snapshot.active &&
                      (item.id === "steer" || item.id === "lens") ? (
                        <>
                          <span className="mono">
                            L{snapshot.active.layer} · N{snapshot.active.start}–
                            {snapshot.active.end - 1}
                          </span>{" "}
                          ·{" "}
                        </>
                      ) : null}
                      {running && state?.eta_seconds != null
                        ? `≈ ${duration(state.eta_seconds)} left`
                        : running && !saved
                          ? "Preparing…"
                          : ""}
                    </span>
                    {state?.updated ? (
                      <time
                        dateTime={new Date(state.updated * 1000).toISOString()}
                        title={new Date(state.updated * 1000).toLocaleString()}
                      >
                        Updated {updateAge(state.updated)}
                      </time>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {state?.error ? (
        <div className="wsum">
          <Slot error>{state.error}</Slot>
        </div>
      ) : null}
      {snapshot ? (
        <div className="wsum dim">
          {compatible ? (
            <p className="build-legend">
              <span>■ saved</span>
              <span>■ in progress</span>
            </p>
          ) : null}
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="link" size="sm" />}>
              About the map
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p>
                Colours show saved analysis coverage, not neuron strength.
                Pending layouts use index order. Connection lines sample N0 in
                each layer.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
    </div>
  );
}
