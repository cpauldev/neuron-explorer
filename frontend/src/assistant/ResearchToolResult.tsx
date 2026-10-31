import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../components/ui/table";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useExplorer } from "../context";
import { Tokens } from "../components/explorer-ui";
import { ToolFallback } from "../components/tool-fallback.aui";
import { TerminalBlock } from "../components/terminal-block";
import { UnitLink } from "./SelectionContext";
import { isRecord, unpack } from "./research";
import type { SelectionContext, Token } from "../types";

const words = (value: unknown): (string | Token)[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is string | Token =>
          typeof v === "string" || (isRecord(v) && typeof v.tok === "string"),
      )
    : [];
function unitOf(
  value: Record<string, unknown>,
  fallbackLayer?: number,
): SelectionContext | null {
  const label =
    typeof value.neuron === "string"
      ? value.neuron
      : typeof value.head === "string"
        ? value.head
        : "";
  const match = /^L(\d+)[ /]([Nh])(\d+)$/.exec(label);
  const layer = match
    ? +match[1]
    : typeof value.layer === "number"
      ? value.layer
      : fallbackLayer;
  const n = match
    ? +match[3]
    : typeof value.n === "number"
      ? value.n
      : undefined;
  return layer !== undefined && n !== undefined
    ? { layer, n, kind: match?.[2] === "h" ? "head" : "neuron" }
    : null;
}
const list = (value: unknown) =>
  Array.isArray(value) ? value.filter(isRecord) : [];
function ToolTable({ values, layer }: { values: unknown; layer?: number }) {
  const [, a] = useExplorer([]);
  const entries = list(values);
  if (!entries.length) return null;
  return (
    <div className="tool-table-wrap">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Unit</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right font-mono tabular-nums">
              Score / weight z
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.slice(0, 40).map((row, i) => {
            const unit = unitOf(row, layer),
              valid =
                unit &&
                (unit.kind === "head"
                  ? a.validHead(unit.layer, unit.n)
                  : a.validNeuron(unit.layer, unit.n));
            return (
              <TableRow key={i}>
                <TableCell>{valid ? <UnitLink unit={unit} /> : "—"}</TableCell>
                <TableCell>
                  {(typeof row.name === "string" && row.name) ||
                    words(row.steer || row.steer_up || row.lens || row.words)
                      .map((t) => (typeof t === "string" ? t : t.tok))
                      .join(" ") ||
                    String(row.token || "")}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {String(row.score ?? row.z ?? row.rank ?? "—")}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {entries.length > 40 ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Showing 40 of {entries.length}; full data below.
        </p>
      ) : null}
    </div>
  );
}
function Heatmap({ value }: { value: unknown }) {
  const pairs = Array.isArray(value)
    ? value.filter(
        (p): p is [string, number] =>
          Array.isArray(p) &&
          typeof p[0] === "string" &&
          typeof p[1] === "number" &&
          Number.isFinite(p[1]),
      )
    : [];
  const max = Math.max(1e-6, ...pairs.map((p) => Math.abs(p[1])));
  return (
    <div className="tool-heatmap" aria-label="Signed activation by token">
      {pairs.map(([token, activation], i) => (
        <span
          key={i}
          title={`${JSON.stringify(token)}: ${activation}`}
          style={{
            background: `rgba(${activation >= 0 ? "255,181,71" : "255,79,154"},${(Math.abs(activation) / max) * 0.8})`,
            color: Math.abs(activation) / max > 0.5 ? "#101214" : undefined,
          }}
        >
          {token}
        </span>
      ))}
    </div>
  );
}
function Comparison({ data }: { data: Record<string, unknown> }) {
  const texts = list(data.texts),
    neurons = list(data.neurons);
  return (
    <div className="tool-table-wrap">
      <p className="text-muted-foreground mb-2 text-xs">
        Peak activation relative to each neuron’s typical extreme. A score of 1
        matches its usual maximum.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Neuron</TableHead>
            {texts.map((t) => (
              <TableHead key={String(t.label)}>{String(t.label)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {neurons.slice(0, 40).map((row, i) => {
            const unit = unitOf(row);
            return (
              <TableRow key={i}>
                <TableCell>{unit ? <UnitLink unit={unit} /> : "—"}</TableCell>
                {texts.map((t) => {
                  const sample = isRecord(row.by_text)
                    ? row.by_text[String(t.label)]
                    : null;
                  return (
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      key={String(t.label)}
                    >
                      {isRecord(sample)
                        ? String(sample.peak_score ?? "—")
                        : "—"}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
function ProbabilityChange({ data }: { data: Record<string, unknown> }) {
  const base = isRecord(data.baseline) ? data.baseline : null,
    alt = isRecord(data.intervened) ? data.intervened : null;
  if (!base || !alt) return null;
  const targets = list(base.targets),
    changes = list(alt.targets);
  const probability = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? `${(Math.exp(v) * 100).toPrecision(3)}%`
      : "—";
  return targets.length ? (
    <div className="tool-table-wrap">
      <p className="text-muted-foreground mb-2 text-xs">
        First-token target probability · baseline versus intervention
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Target</TableHead>
            <TableHead>Baseline</TableHead>
            <TableHead>Intervened</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {targets.map((t, i) => (
            <TableRow key={i}>
              <TableCell>
                <code>{String(t.text)}</code>
                {t.first_token_only ? " (first token)" : ""}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {probability(t.logprob)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {probability(changes.find((c) => c.text === t.text)?.logprob)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ) : null;
}

// Render actual backend results; tool execution stays in Python. Raw details
// remain available through the official fallback rather than a second viewer.
export const ResearchToolResult: ToolCallMessagePartComponent = (props) => {
  const { toolName, args, result, isError, status } = props;
  const [, a] = useExplorer([]),
    name = toolName.split("__").at(-1)!,
    value = unpack(result),
    data = isRecord(value) ? value : null;
  const layer = typeof args.layer === "number" ? args.layer : undefined;
  if (isError || typeof data?.error === "string")
    return (
      <div
        className="my-2 rounded-lg border border-destructive/30 p-3 text-sm"
        role="status"
      >
        <p className="text-destructive mb-1">{name} could not complete</p>
        <ToolFallback
          {...props}
          status={{
            type: "incomplete",
            reason: "error",
            error: data?.error || result,
          }}
        />
      </div>
    );
  if (name === "run_shell") {
    const output =
      typeof data?.output === "string"
        ? data.output
        : typeof value === "string"
          ? value
          : "";
    const lines = output ? output.split("\n") : [];
    return (
      <TerminalBlock
        command={typeof args.command === "string" ? args.command : ""}
        cwd={typeof args.cwd === "string" ? args.cwd : undefined}
        lines={lines}
        exitCode={
          typeof data?.exit_code === "number" ? data.exit_code : undefined
        }
        done={result !== undefined || status.type === "incomplete"}
        visibleCount={lines.length}
        maxCollapsedLines={12}
        truncated={data?.truncated === true}
        className="research-terminal"
      />
    );
  }
  let rich = null;
  if (data) {
    if (name === "steer" && typeof data.baseline === "string")
      rich = (
        <div className="tool-comparison">
          {(
            [
              ["Requested dose", data.up, "up"],
              ["Baseline", data.baseline, "zero"],
              ["Opposite dose", data.down, "down"],
            ] as const
          ).map(([label, text, cls]) => (
            <div className={`col ${cls}`} key={cls}>
              <span className="lab">{label}</span>
              {typeof text === "string" ? text : ""}
            </div>
          ))}
        </div>
      );
    else if (["search_lens", "top_firing", "cone"].includes(name))
      rich = (
        <>
          {typeof data.note === "string" ? (
            <p className="text-muted-foreground px-2 text-xs">{data.note}</p>
          ) : null}
          <ToolTable
            values={data.results || data.neurons || data.nodes}
            layer={layer}
          />
        </>
      );
    else if (name === "activations") rich = <Heatmap value={data.tokens} />;
    else if (name === "compare") rich = <Comparison data={data} />;
    else if (name === "logprobs") rich = <ProbabilityChange data={data} />;
    else if (name === "web_summary")
      rich = (
        <div className="p-3 text-xs">
          <p className="mb-2 font-medium">
            Pooled connection tokens · weight-based leads
          </p>
          <dl>
            {[
              ["fed_by", "Fed by"],
              ["held_by", "Held back by"],
              ["toward", "Pushes toward"],
              ["away", "Pushes away from"],
            ].map(([key, label]) => (
              <div className="mb-2" key={key}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{words(data[key]).join(", ") || "No tokens available"}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    else if (["neuron", "head"].includes(name)) {
      const unit =
        unitOf(data) ||
        (layer !== undefined
          ? {
              layer,
              n: Number(args.n ?? args.head),
              kind: name === "head" ? ("head" as const) : ("neuron" as const),
            }
          : null);
      if (
        unit &&
        (unit.kind === "head"
          ? a.validHead(unit.layer, unit.n)
          : a.validNeuron(unit.layer, unit.n))
      )
        rich = (
          <div className="tool-neuron-card">
            <UnitLink unit={unit} />
            {typeof data.name === "string" && data.name ? (
              <strong>{data.name}</strong>
            ) : null}
            {unit.kind === "neuron" ? (
              <>
                {[
                  [
                    data.steer_up
                      ? "Positive steering lens"
                      : "Positive logit lens",
                    data.steer_up || data.lens_up,
                  ],
                  [
                    data.steer_down
                      ? "Negative steering lens"
                      : "Negative logit lens",
                    data.steer_down || data.lens_down,
                  ],
                ].map(([label, tokens]) => (
                  <div key={String(label)} className="mt-2">
                    <div className="lab">{String(label)}</div>
                    <Tokens values={words(tokens).slice(0, 8)} />
                  </div>
                ))}
              </>
            ) : (
              <>
                {["q", "k", "v", "o"].map((role) => (
                  <div key={role} className="mt-2">
                    <div className="lab">{role} role</div>
                    <Tokens
                      values={words(
                        isRecord(data[role]) ? data[role].tokens : [],
                      ).slice(0, 8)}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        );
    }
  } else if (Array.isArray(value) && name === "top_units")
    rich = <ToolTable values={value} layer={layer} />;
  return (
    <div className="research-tool">
      {rich}
      <ToolFallback {...props} />
    </div>
  );
};
