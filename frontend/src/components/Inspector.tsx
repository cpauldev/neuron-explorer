import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./ui/table";

import type {
  Activation,
  ChatTurn,
  Connection,
  HeadRole,
  Rollout,
} from "../types";
import { Fragment, useEffect, useRef, useState } from "react";
import { useExplorer } from "../context";
import { fmtDose, refLabel } from "../lib/store";
import { HeadNeurons, LensSummary, ConnectionSummary } from "./Analysis";
import { Segmented, Slot, Tokens } from "./explorer-ui";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ChoiceSelect } from "./choice-select";
import { Field, FieldLabel } from "./ui/field";
import { ConfirmDialog } from "./confirm-dialog";

function ConnectionTable({ list = [] }: { list?: Connection[] }) {
  const [, a] = useExplorer([]);
  if (!list.length)
    return (
      <p className="text-xs text-muted-foreground">No saved connections.</p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="sr-only">Direction</span>
          </TableHead>
          <TableHead>Tokens</TableHead>
          <TableHead className="text-right">Weight z</TableHead>
          <TableHead>Neuron</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.slice(0, 14).map((c) => {
          const positive = c.sign > 0,
            tokens = (positive ? c.lens : c.lens_neg) || [],
            logit = (positive ? c.logit : c.logit_neg) || [];
          return (
            <TableRow
              className="con"
              key={`${c.layer}/${c.n}`}
              data-l={c.layer}
              data-n={c.n}
            >
              <TableCell className={`pole ${positive ? "up" : "down"}`}>
                {positive ? "↑" : "↓"}
              </TableCell>
              <TableCell>
                <Tokens values={tokens.slice(0, 4)} />
                {logit.length ? (
                  <div className="logit">
                    <Tokens values={logit.slice(0, 4)} />
                  </div>
                ) : null}
                {c.name || c.words?.length ? (
                  <div className="dim">
                    {c.name || (c.words || []).join(" ")}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                {c.z.toFixed(0)}
              </TableCell>
              <TableCell>
                <Button
                  variant="link"
                  size="sm"
                  aria-label={`Open L${c.layer} N${c.n}`}
                  onClick={() => a.goToNeuron(c.layer, c.n)}
                >
                  L{c.layer}·{c.n}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
function HeadConnections() {
  const [s, a] = useExplorer(["nheads", "headCache"]);
  if (!s.nheads?.roles) return null;
  const rows = (roles: readonly HeadRole[]) =>
    roles
      .flatMap((role) =>
        (s.nheads!.roles[role] || []).map((x) => ({ ...x, role })),
      )
      .filter((x) => x.z >= 2)
      .sort((a, b) => b.z - a.z)
      .slice(0, 10);
  return (
    <div className="lens">
      {(
        [
          ["Downstream attention heads", ["q", "k", "v"]],
          ["Upstream attention heads", ["o"]],
        ] as const
      )
        .filter(([, roles]) => rows(roles).length)
        .map(([label, roles]) => (
          <section className="space-y-2" key={label}>
            <h4 className="text-sm font-medium">{label}</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead className="text-right">Weight z</TableHead>
                  <TableHead>Head</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows(roles).map((x, i) => {
                  const h = s.headCache[`h/${x.layer}/${x.head}`];
                  const id = `L${x.layer}·h${x.heads?.length > 1 ? `${x.heads[0]}–${x.heads.at(-1)}` : x.head}`;
                  return (
                    <TableRow
                      className="con"
                      key={`${x.role}/${x.layer}/${x.head}/${i}`}
                      onMouseEnter={() => a.hoverHead(x.layer, x.head)}
                      onMouseLeave={() => a.hoverHead(null)}
                    >
                      <TableCell className="pole mono dim">{x.role}</TableCell>
                      <TableCell>
                        {h ? (
                          <>
                            <Tokens values={(h.write_toks || []).slice(0, 4)} />
                            <div className="logit">
                              <Tokens
                                values={(h.read_toks || []).slice(0, 4)}
                              />
                            </div>
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                        {x.z.toFixed(1)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="link"
                          size="sm"
                          type="button"
                          title={`Open attention head ${id}`}
                          onClick={() =>
                            a.safe(a.select(x.layer, x.head, "head"))
                          }
                        >
                          {id}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        ))}
    </div>
  );
}
export function Details() {
  const [s] = useExplorer([
    "focus",
    "loading",
    "loadError",
    "unit",
    "headInfo",
    "lens",
    "con",
    "lensError",
    "conError",
  ]);
  if (s.loading)
    return (
      <Slot>
        Loading {s.focus?.kind === "head" ? "attention head" : "neuron details"}
        …
      </Slot>
    );
  if (s.loadError)
    return <Slot error>Could not load this selection: {s.loadError}</Slot>;
  if (s.focus?.kind === "head")
    return s.headInfo ? (
      <>
        <div className="lab">
          {s.headInfo.full ? "Full" : "Linear"} attention · q: query · k: key ·
          v: value · o: output
        </div>
        <HeadNeurons head={s.headInfo} />
      </>
    ) : null;
  const stats = s.unit?.stats;
  return (
    <>
      {stats ? (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">Saved rank</dt>
              <dd className="mt-1 font-mono">
                {s.unit?.rank ? `${s.unit.rank} / ${s.unit.n_ranked}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Feature mass</dt>
              <dd className="mt-1 font-mono">
                {(stats.mass ?? stats.z).toFixed(1)}
              </dd>
            </div>
            <div className="col-span-2">
              <dt
                className="text-muted-foreground"
                title="Share of sampled random-direction controls with a lower feature mass."
              >
                Above random controls
              </dt>
              <dd className="mt-1 font-mono">
                {typeof stats.null_pct === "number"
                  ? `${(stats.null_pct * 100).toFixed(0)}%`
                  : "No controls available"}
              </dd>
            </div>
          </dl>
          <h3 className="mb-2 text-sm font-medium">
            Words in saved generations
          </h3>
          <div className="crumbs">
            {stats.words.map(([word, count, z]) => (
              <span
                className="tok"
                key={word}
                title={`${count} rollouts · z ${z.toFixed(1)} · ${(stats.per_prompt[word] || []).join(" ")}`}
              >
                {word}
              </span>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {["dose", "push", "distinct-4", "capped", "logprob"].map(
                  (text) => (
                    <TableHead
                      key={text}
                      className="text-right font-mono tabular-nums"
                    >
                      {text}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(stats.dose).map(([dose, v]) => (
                <TableRow key={dose}>
                  {[
                    dose,
                    v.rel_push.toFixed(2),
                    v.distinct4.toFixed(2),
                    `${(v.capped * 100).toFixed(0)}%`,
                    v.logprob.toFixed(2),
                  ].map((value, i) => (
                    <TableCell
                      className="text-right font-mono tabular-nums"
                      key={i}
                    >
                      {value}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : null}
      <div id="d-lens">
        {s.lens ? (
          <LensSummary lens={s.lens} />
        ) : (
          <Slot error={Boolean(s.lensError)}>
            {s.lensError ||
              (s.focus?.kind === "neuron"
                ? "Loading token associations…"
                : "—")}
          </Slot>
        )}
      </div>
      <h3 className="mt-6 mb-3 text-sm font-medium">Connections</h3>
      <div id="d-con-wrap">
        {s.con ? (
          <div className="lens">
            <div>
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">
                Downstream neurons
              </h4>
              <ConnectionTable list={s.con.down} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">
                Upstream neurons
              </h4>
              <ConnectionTable list={s.con.up} />
            </div>
          </div>
        ) : (
          <Slot error={Boolean(s.conError)}>
            {s.conError ||
              (s.focus?.kind === "neuron" ? "Loading connections…" : "—")}
          </Slot>
        )}
        <HeadConnections />
      </div>
      <ConnectionSummary />
    </>
  );
}
function ExampleCell({
  rollout,
  baseline = false,
  span,
  showDose = false,
}: {
  rollout?: Rollout;
  baseline?: boolean;
  span?: number;
  showDose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`cell${baseline ? " base" : ""}${rollout?.finish === "length" ? " capped" : ""}${open ? " open" : ""}`}
      style={span ? { gridColumn: `span ${span}` } : undefined}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title="Expand or collapse this saved response"
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (["Enter", " "].includes(e.key)) {
          e.preventDefault();
          setOpen((v) => !v);
        }
      }}
    >
      {showDose && rollout ? (
        <span className={`h ${rollout.dose > 0 ? "up" : "down"}`}>
          {fmtDose(rollout.dose)} · {rollout.rel_push.toFixed(2)}{" "}
        </span>
      ) : null}
      {rollout?.text || ""}
    </div>
  );
}
export function Examples() {
  const [s] = useExplorer(["unit", "loading", "loadError"]);
  if (s.loading) return <Slot>Loading examples…</Slot>;
  if (s.loadError)
    return <Slot error>Could not load examples: {s.loadError}</Slot>;
  const u = s.unit;
  if (!u?.rollouts?.length)
    return (
      <Slot>
        No saved steering examples for this neuron. Use Experiment to compare
        its effects live.
      </Slot>
    );
  const count: Record<number, number> = {};
  for (const r of u.rollouts) count[r.dose] = (count[r.dose] || 0) + 1;
  const shared = Object.keys(count)
    .map(Number)
    .filter((d) => count[d] > 1)
    .sort((a, b) => a - b);
  // With a single prompt, every dose still needs a column.
  const doses = shared.length
    ? shared
    : Object.keys(count)
        .map(Number)
        .sort((a, b) => a - b);
  const prompts = Object.keys(u.prompts).filter((p) =>
    u.rollouts!.some((r) => r.prompt === p),
  );
  return (
    <div
      className="example-grid"
      style={{
        gridTemplateColumns: `66px repeat(${1 + doses.length}, minmax(0,1fr))`,
      }}
    >
      <div className="h" />
      <div className="h">0</div>
      {doses.map((d) => (
        <div className={`h ${d > 0 ? "up" : "down"}`} key={d}>
          {fmtDose(d)}
          <span className="dim">
            {" "}
            · {u.rollouts!.find((r) => r.dose === d)!.rel_push.toFixed(2)}
          </span>
        </div>
      ))}
      {prompts.map((p) => {
        const mine = u.rollouts!.filter((r) => r.prompt === p),
          cells = doses.map((d) => mine.find((r) => r.dose === d)),
          extra = mine.filter((r) => !doses.includes(r.dose));
        return (
          <Fragment key={p}>
            <div className="h">{p}</div>
            <ExampleCell
              rollout={u.baselines.find((r) => r.prompt === p)}
              baseline
            />
            {cells.some(Boolean)
              ? cells.map((r, i) =>
                  r ? (
                    <ExampleCell key={doses[i]} rollout={r} />
                  ) : (
                    <div key={doses[i]} />
                  ),
                )
              : extra.length
                ? extra.map((r, i) => {
                    const span = Math.max(
                      1,
                      Math.floor(doses.length / extra.length),
                    );
                    return (
                      <ExampleCell
                        key={r.dose}
                        rollout={r}
                        showDose
                        span={
                          i === extra.length - 1
                            ? Math.max(1, doses.length - span * i)
                            : span
                        }
                      />
                    );
                  })
                : doses.map((d) => <div key={d} />)}
          </Fragment>
        );
      })}
    </div>
  );
}
export function SteeringComparison({ turn }: { turn: ChatTurn }) {
  const doses =
    turn.mode === "mul"
      ? [`×${turn.dose}`, "×1", `×${-turn.dose}`]
      : [fmtDose(turn.dose), "0", fmtDose(-turn.dose)];
  const labels = ["Requested dose", "Baseline", "Opposite dose"].map(
    (label, index) => `${label} · ${doses[index]}`,
  );
  return (
    <div className="turn">
      <div className="user">
        {turn.user}
        <span className="recipe">
          {turn.mode === "mul" ? "×" : "add"} {turn.dose}
        </span>
      </div>
      <div className="cols">
        {["up", "zero", "down"].map((cls, i) => (
          <div key={cls} className={`col ${cls}${turn.live ? " live" : ""}`}>
            <span className="lab">{labels[i]}</span>
            {turn.replies[i]}
          </div>
        ))}
        {turn.error ? <div className="err">{turn.error}</div> : null}
      </div>
    </div>
  );
}
export function TokenHeatmap({ units }: { units: Activation[] }) {
  const max = Math.max(1e-6, ...units.map((u) => Math.abs(u.act)));
  return units.map((u, i) => {
    const a = u.act / max;
    return (
      <span
        key={i}
        style={{
          background: `rgba(${a >= 0 ? "255,181,71" : "255,79,154"},${Math.abs(a) * 0.85})`,
          color: Math.abs(a) >= 0.5 ? "#101214" : "var(--ink)",
        }}
        title={(u.pieces || [u.act]).map((v) => v.toFixed(3)).join(" · ")}
      >
        {u.text}
      </span>
    );
  });
}
export function LocalChat() {
  const [s, a] = useExplorer(["chat"]);
  const [clearOpen, setClearOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null),
    following = useRef(true),
    c = s.chat,
    reads = c.dir === "reads";
  useEffect(() => {
    if (following.current && threadRef.current)
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [c.thread]);
  const hasContent = reads ? Boolean(c.reads) : Boolean(c.thread.length);
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {reads
          ? "Measure how this neuron activates on each token in your text. No intervention is applied."
          : "Compare the local model at the requested dose, baseline and the opposite dose."}
      </p>
      <form
        id="c-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (c.running) a.cancelChat();
          else a.safe(a.submitChat());
        }}
      >
        <Segmented
          id="c-dir"
          value={c.dir}
          label="Experiment type"
          disabled={c.running}
          options={[
            { value: "writes", text: "Compare outputs" },
            { value: "reads", text: "Read activations" },
          ]}
          onChange={(direction) =>
            a.controls({
              direction: direction === "reads" ? "reads you" : "writes",
            })
          }
        />
        {!reads ? (
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="c-mode">Intervention</FieldLabel>
              <ChoiceSelect
                id="c-mode"
                className="w-full"
                value={c.mode}
                aria-label="Intervention method"
                disabled={c.running}
                onValueChange={(mode) => a.controls({ mode })}
                options={[
                  { value: "add", label: "Add direction" },
                  { value: "mul", label: "Multiply activation" },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="c-dose">Dose</FieldLabel>
              <Input
                id="c-dose"
                className="font-mono"
                inputMode="decimal"
                aria-label="dose"
                value={c.doseInput}
                disabled={c.running}
                onChange={(event) =>
                  a.chatSet({ doseInput: event.target.value })
                }
                onBlur={a.applyDose}
              />
            </Field>
          </div>
        ) : null}
        <Field>
          <FieldLabel htmlFor="c-input">
            {reads ? "Text to measure" : "Generation prompt"}
          </FieldLabel>
          <Textarea
            id="c-input"
            name="neuron-prompt"
            rows={3}
            placeholder={reads ? "Paste text to measure…" : "Who are you?"}
            required={!c.running}
            value={c.prompt}
            onChange={(event) => a.chatSet({ prompt: event.target.value })}
          />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Button id="c-go" type="submit">
            {c.running
              ? "Stop experiment"
              : reads
                ? "Measure activations"
                : "Run comparison"}
          </Button>
          <ConfirmDialog
            open={clearOpen}
            onOpenChange={setClearOpen}
            title="Clear experiment results?"
            description="Clear this neuron's experiment history and activation result. This cannot be undone."
            confirmLabel="Clear results"
            onConfirm={() => a.chatSet({ thread: [], reads: null, error: "" })}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={c.running || !hasContent}
              >
                Clear
              </Button>
            }
          />
        </div>
      </form>
      {c.error ? (
        <div
          id="c-error"
          className="text-sm text-destructive"
          role="status"
          aria-live="polite"
        >
          {c.error}
        </div>
      ) : null}
      {!hasContent ? (
        <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
          {reads
            ? "Token activations will appear here."
            : "Comparison results will appear here."}
        </p>
      ) : null}
      {!reads ? (
        <div
          id="c-thread"
          ref={threadRef}
          aria-busy={c.running}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              80;
          }}
        >
          {c.thread.map((turn, index) => (
            <SteeringComparison key={index} turn={turn} />
          ))}
        </div>
      ) : null}
      {reads && c.reads ? (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            Orange: positive · Pink: negative. Hover a token for its activation.
          </p>
          <div id="c-reads" className="whitespace-pre-wrap">
            <TokenHeatmap units={c.reads} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SelectionPanel() {
  const [s, a] = useExplorer([
    "focus",
    "selectionTab",
    "fresh",
    "name",
    "nameSaved",
  ]);
  if (!s.focus)
    return (
      <div className="space-y-3 p-6">
        <h3 className="text-sm font-medium">No unit selected</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Select a neuron or attention head on the map, choose a search result,
          or enter its ID in Go to unit.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => a.openTool("search")}
        >
          Find a neuron
        </Button>
      </div>
    );
  return (
    <Tabs
      value={s.selectionTab}
      onValueChange={(tab) => a.setTab(tab as "chat" | "details" | "examples")}
      className="min-h-0 min-w-0 w-full flex-1 gap-0"
    >
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-mono text-sm font-medium">
              {refLabel(s.focus)}
            </h3>
            <p className="text-xs text-muted-foreground">
              {s.focus.kind === "head"
                ? "Attention head"
                : s.focus.kind === "random"
                  ? "Random control"
                  : "Neuron"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Clear selection"
            onClick={a.closeFocus}
          >
            Clear
          </Button>
        </div>
        {s.focus.kind === "neuron" ? (
          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="f-name">Feature name</FieldLabel>
              <span role="status" className="text-xs text-muted-foreground">
                {s.nameSaved ? "Saved" : ""}
              </span>
            </div>
            <Input
              id="f-name"
              name="feature-name"
              placeholder="Name this neuron…"
              value={s.name}
              onChange={(event) => a.rename(event.target.value)}
              onBlur={a.flushName}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing)
                  event.currentTarget.blur();
              }}
            />
          </Field>
        ) : null}
      </div>
      <TabsList variant="line" className="m-2" aria-label="Selected unit views">
        {(
          [
            ["details", "Overview"],
            ["chat", "Experiment"],
            ["examples", "Saved examples"],
          ] as const
        ).map(([tab, label]) => (
          <TabsTrigger
            value={tab}
            key={tab}
            disabled={
              (s.focus?.kind === "head" && tab !== "details") ||
              (s.focus?.kind === "random" && tab === "chat")
            }
            title={
              s.focus?.kind === "head" && tab !== "details"
                ? "Select a neuron to use this view."
                : undefined
            }
          >
            {label}
            {s.fresh[tab] ? (
              <span
                className="size-1.5 rounded-full bg-primary"
                aria-label="New result"
              />
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="details" keepMounted className="inspector-content">
        <Details />
      </TabsContent>
      <TabsContent value="chat" keepMounted className="inspector-content">
        <LocalChat />
      </TabsContent>
      <TabsContent value="examples" keepMounted className="inspector-content">
        <Examples />
      </TabsContent>
    </Tabs>
  );
}
