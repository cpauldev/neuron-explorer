import type { Ref, ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useExplorer } from "../context";
import { fmtDose } from "../lib/store";
import { TabsContent } from "./ui/tabs";

export function Viewport({
  mapRef,
  labelsRef,
  scatterRef,
}: {
  mapRef: Ref<HTMLCanvasElement>;
  labelsRef: Ref<HTMLDivElement>;
  scatterRef: Ref<HTMLCanvasElement>;
}) {
  const [s] = useExplorer(["view", "embedLoading", "embedAvailable", "layer"]);
  return (
    <>
      <TabsContent
        id="map-view"
        value="map"
        keepMounted
        className={`view${s.view === "map" ? " on" : ""}`}
      >
        <canvas id="map" ref={mapRef} aria-label="Interactive 3D model map" />
        <div id="layer-labels" ref={labelsRef} />
      </TabsContent>
      <TabsContent
        id="embed-view"
        value="embed"
        keepMounted
        className={`view${s.view === "embed" ? " on" : ""}`}
      >
        <canvas
          id="scatter"
          ref={scatterRef}
          aria-label="Interactive rollout embeddings"
        />
        <div id="embed-empty" className="slot">
          {s.embedLoading
            ? "Loading embeddings…"
            : s.embedAvailable
              ? ""
              : `No saved embeddings for L${s.layer}. Choose a layer with saved examples.`}
        </div>
      </TabsContent>
    </>
  );
}
export function Tooltip() {
  const [s] = useExplorer(["tooltip", "arch"]);
  const ref = useRef<HTMLDivElement>(null),
    tip = s.tooltip;
  useLayoutEffect(() => {
    if (!ref.current || !tip) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.left = `${Math.max(8, Math.min(tip.x + 14, innerWidth - r.width - 8))}px`;
    ref.current.style.top = `${Math.max(8, Math.min(tip.y + 14, innerHeight - r.height - 8))}px`;
  }, [tip]);
  if (!tip) return null;
  const p = tip.pick!,
    data = tip.data,
    unit = tip.unit;
  let title: string, body: ReactNode;
  if (tip.rollout) {
    const d = tip.rollout,
      i = d.i;
    title = `${d.kind[i] === "baseline" ? "baseline" : (d.kind[i] === "random" ? "random " : "N") + d.neuron[i]} · ${d.prompt[i]} · ${fmtDose(d.dose[i])}`;
    body = d.text;
  } else if (p.type === "block") {
    title = `L${p.layer}`;
    body = p.full
      ? `full attention · ${s.arch.attn_heads} q / ${s.arch.kv_heads} kv heads`
      : `linear attention · ${s.arch.linear_k_heads} k / ${s.arch.linear_v_heads} v heads`;
  } else if (p.type === "head") {
    title = `L${p.layer} h${p.head}`;
    body = data ? (
      <>
        {(
          [
            ["←", data.reads],
            ["→", data.writes],
          ] as const
        ).map(([arrow, list]) => (
          <div key={arrow}>
            {(list || []).slice(0, 3).map((c) => (
              <div className="tl" key={`${c.layer}/${c.n}`}>
                <span className="sgn">{arrow}</span>
                <span className="faint">
                  L{c.layer} N{c.n}
                </span>{" "}
                {(c.lens || []).slice(0, 4).join("  ")}
              </div>
            ))}
          </div>
        ))}
      </>
    ) : null;
  } else {
    title = `L${p.layer} N${p.n}${unit ? `  mass ${unit.z.toFixed(1)}` : ""}`;
    body = (
      <>
        {unit?.name ? <div className="tname">{unit.name}</div> : null}
        {unit ? <div className="twords">{unit.words.join("  ")}</div> : null}
        {data ? (
          <>
            {data.steer ? (
              <>
                <div className="tl">
                  <span className="sgn up">+</span>
                  {data.steer.join("  ")}
                </div>
                <div className="tl">
                  <span className="sgn down">−</span>
                  {(data.steer_neg || []).join("  ")}
                </div>
              </>
            ) : null}
            <div className="tl faintline">
              <span className="sgn up">+</span>
              {(data.lens || []).join("  ")}
            </div>
            <div className="tl faintline">
              <span className="sgn down">−</span>
              {(data.lens_neg || []).join("  ")}
            </div>
          </>
        ) : null}
      </>
    );
  }
  return createPortal(
    <div
      id="tip"
      className="rounded-lg border bg-popover text-sm text-popover-foreground shadow-md"
      ref={ref}
      style={{ display: "block", left: tip.x + 14, top: tip.y + 14 }}
    >
      <div className="lab">{title}</div>
      {body}
    </div>,
    document.body,
  );
}
