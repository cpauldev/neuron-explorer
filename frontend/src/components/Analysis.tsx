import type { Lens, HeadInfo, SearchResults, SelectionKind } from "../types";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { useExplorer } from "../context";
import { ROLE_COL, ROLE_LABEL } from "../explorer";
import { Segmented, Slot, Tokens } from "./explorer-ui";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Toggle } from "./ui/toggle";
import { ChoiceSelect } from "./choice-select";
import { Field, FieldLabel } from "./ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "./ui/input-group";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./ui/collapsible";

export function LensSummary({
  lens,
  search = false,
}: {
  lens: Lens | null;
  search?: boolean;
}) {
  const [, a] = useExplorer([]);
  if (!lens) return null;
  const pair = (up: string[] = [], down: string[] = []) =>
    (
      [
        ["+", up],
        ["−", down],
      ] as const
    ).map(([sign, values]) => (
      <div className="lrow" key={sign}>
        <span className={`sgn ${sign === "+" ? "up" : "down"}`}>{sign}</span>
        <div className="chips">
          <Tokens
            values={values.slice(0, 12)}
            onSearch={search ? (token) => a.search(token, "lens") : undefined}
          />
        </div>
      </div>
    ));
  return (
    <div className="space-y-4">
      {lens.steer_up ? (
        <section>
          <h3 className="mb-2 text-sm font-medium">
            Steering token associations
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            KL {lens.kl_up} / {lens.kl_down}
          </p>
          {pair(lens.steer_up, lens.steer_down)}
        </section>
      ) : null}
      <section>
        <h3 className="mb-2 text-sm font-medium">Logit lens</h3>
        {pair(lens.up, lens.down)}
      </section>
    </div>
  );
}

export function HeadNeurons({ head }: { head: HeadInfo | null }) {
  const [s, a] = useExplorer(["units"]);
  if (!head) return null;
  return (["q", "k", "v", "o"] as const).map((role) => {
    const links =
      role === "v" ? head.reads : role === "o" ? head.writes : head[role];
    return (
      <section className="mb-4" key={role}>
        <h3 className="mb-2 text-sm font-medium">
          <span className="sw" style={{ background: ROLE_COL[role] }} />
          {role} · {ROLE_LABEL[role]}
        </h3>
        {(links || []).slice(0, 10).map((connection) => (
          <Button
            variant="ghost"
            className="nline h-auto w-full justify-start text-left"
            key={`${connection.layer}/${connection.n}`}
            onClick={() => a.goToNeuron(connection.layer, connection.n)}
          >
            <span className="id">
              L{connection.layer} N{connection.n}
            </span>
            <span className="w">
              {s.units[connection.layer]?.find(
                (unit) => unit.n === connection.n && unit.kind === "neuron",
              )?.name || (connection.lens || []).join(" ")}
            </span>
            <span className="z">{connection.z.toFixed(0)}</span>
          </Button>
        ))}
      </section>
    );
  });
}

export function ConnectionSummary() {
  const [s, a] = useExplorer(["webSum"]);
  const web = s.webSum;
  if (!web) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Connection token summary</h3>
      <p className="text-xs text-muted-foreground">
        Weight-based leads across {web.links} links. Associations do not
        establish causal effects.
      </p>
      {(
        [
          ["Fed by", web.up?.fed_by],
          ["Held back by", web.up?.held_by],
          ["Pushes toward", web.down?.toward],
          ["Pushes away from", web.down?.away],
        ] as const
      ).map(([label, values]) => (
        <div key={label}>
          <h4 className="mb-1 text-xs text-muted-foreground">{label}</h4>
          <div className="chips">
            {values?.length ? (
              <Tokens
                values={values}
                onSearch={(token) => a.search(token, "lens")}
              />
            ) : (
              <span className="text-xs text-muted-foreground">
                No associations available.
              </span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

export function ResultRows({
  results,
  id,
}: {
  results: SearchResults | null;
  id: string;
}) {
  const [s, a] = useExplorer([
    "layer",
    "focus",
    "units",
    "filter",
    "showRandom",
    "statusText",
    "lensQuery",
    "analysisText",
  ]);
  const select = (
    layer: number,
    n: number,
    kind: SelectionKind = "neuron",
  ) => ({
    "aria-label": `Open L${layer} ${kind === "head" ? "h" : kind === "random" ? "random control " : "N"}${n}`,
    onClick: () => a.goToNeuron(layer, n, kind),
    onPointerEnter: () => kind === "neuron" && a.hoverNeuron(layer, n),
    onPointerLeave: () => a.hoverNeuron(null),
  });
  if (results?.error)
    return (
      <div role="alert" className="space-y-2 p-4">
        <p className="text-sm text-destructive">{results.error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            a.search(
              results.fires ? s.analysisText : s.lensQuery,
              results.fires ? "fires" : "lens",
            )
          }
        >
          Try again
        </Button>
      </div>
    );
  if (results && !results.ready)
    return (
      <Slot>
        <span className="flex items-center gap-2">
          {results.loading ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {results.loading
            ? results.fires
              ? "Analyzing text…"
              : "Searching…"
            : s.statusText || "Analysis is not ready yet."}
        </span>
      </Slot>
    );
  if (results)
    return (
      <div className="results-region">
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {(results.total ?? 0) > (results.results?.length ?? 0)
            ? `Showing ${results.results?.length ?? 0} of ${results.total}`
            : (results.total ?? results.results?.length ?? 0)}{" "}
          matching neurons ·{" "}
          {results.fires
            ? "activation relative to each neuron's typical extreme"
            : "all layers"}
        </p>
        <ol id={id} className="rows">
          {(results.results || []).map((row, index) => (
            <li
              key={`${row.layer}/${row.n}/${row.sign}/${index}`}
              className={`res${row.swept === false ? " unswept" : ""}`}
              data-n={row.n}
            >
              <Button
                variant="ghost"
                className="result-row"
                {...select(row.layer, row.n)}
              >
                <span className="n">
                  L{row.layer} N{row.n}
                </span>
                <span className={`sg ${row.sign === "+" ? "up" : "down"}`}>
                  {results.fires
                    ? `${row.sign === "+" ? "" : "−"}${row.score.toFixed(1)}×`
                    : `${row.sign === "+" ? "+" : "−"}${row.rank + 1}`}
                </span>
                <span
                  className="w"
                  title={[row.name, ...(row.lens || [])]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {row.token ? (
                    <span className="tk">“{row.token}” </span>
                  ) : null}
                  {row.name ? <b>{row.name} </b> : null}
                  {(row.lens || []).join(" ")}
                </span>
              </Button>
            </li>
          ))}
        </ol>
        {!results.results?.length ? (
          <Slot>
            No neurons match. Try another query or adjust the filters.
          </Slot>
        ) : null}
      </div>
    );
  const query = s.filter.trim().toLowerCase();
  const units = (s.units[s.layer] || []).filter(
    (unit) =>
      (s.showRandom || unit.kind === "neuron") &&
      (!query ||
        unit.words.some((word) => word.toLowerCase().includes(query)) ||
        unit.name?.toLowerCase().includes(query) ||
        String(unit.n) === query),
  );
  return (
    <ol id={id} className="rows">
      {units.length ? (
        units.slice(0, 600).map((unit) => (
          <li
            data-n={unit.n}
            key={`${unit.kind}/${unit.n}`}
            className={
              s.focus?.layer === s.layer &&
              s.focus.n === unit.n &&
              s.focus.kind === unit.kind
                ? "sel"
                : ""
            }
          >
            <Button
              variant="ghost"
              className="result-row"
              {...select(s.layer, unit.n, unit.kind)}
            >
              <span className="n">
                {unit.kind === "random" ? "r" : "N"}
                {unit.n}
              </span>
              <span className="z">{unit.z.toFixed(1)}</span>
              <span className="w">
                {unit.name ? <b>{unit.name} </b> : null}
                {unit.words.join(" ")}
              </span>
            </Button>
          </li>
        ))
      ) : (
        <li className="head">
          {query
            ? "No saved features match this filter."
            : `No saved examples for L${s.layer}. Search token associations across the model, or select a unit on the map to inspect it live.`}
        </li>
      )}
    </ol>
  );
}

export function SearchPanel() {
  const [s, a] = useExplorer([
    "arch",
    "index",
    "layer",
    "units",
    "lensQuery",
    "lensResults",
    "filter",
    "showRandom",
  ]);
  const saved = s.units[s.layer] || [];
  return (
    <div className="tool-pane">
      <div className="space-y-3 border-b p-4">
        <div>
          <h3 className="text-sm font-medium">Find neurons</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Search weight-based token associations across all layers.
          </p>
        </div>
        <form
          className="w-full"
          onSubmit={(event) => {
            event.preventDefault();
            a.search(s.lensQuery, "lens");
          }}
        >
          <InputGroup>
            <InputGroupInput
              name="neuron-search"
              aria-label="Search token associations"
              value={s.lensQuery}
              onChange={(event) => a.search(event.target.value, "lens")}
              placeholder="A token or concept…"
              autoComplete="off"
              spellCheck={false}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                size="icon-xs"
                aria-label="Search neurons"
              >
                <SearchIcon aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        {s.lensQuery ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => a.search("", "lens")}
          >
            Clear search
          </Button>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="browse-layer"
                className="text-xs text-muted-foreground"
              >
                Browse saved examples
              </label>
              <ChoiceSelect
                id="browse-layer"
                aria-label="Browse saved examples"
                value={s.layer}
                onValueChange={a.enterLayer}
                options={Array.from(
                  { length: s.arch.n_layers },
                  (_, layer) => ({
                    value: layer,
                    label: `L${layer}${s.index.layers[layer] ? " · saved" : ""}`,
                  }),
                )}
              />
            </div>
            {saved.length ? (
              <>
                <Input
                  aria-label="Filter saved features"
                  placeholder="Filter by saved name or token…"
                  value={s.filter}
                  onChange={(event) => a.set({ filter: event.target.value })}
                />
                {saved.some((unit) => unit.kind === "random") ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={s.showRandom}
                      onCheckedChange={(checked) =>
                        a.set({ showRandom: checked })
                      }
                    />
                    Include random controls
                  </label>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
      {s.lensQuery.trim().length === 1 ? (
        <Slot>Enter at least two characters to search.</Slot>
      ) : (
        <ResultRows
          id="search-results"
          results={
            s.lensQuery.trim().length >= 2
              ? s.lensResults || { ready: false, loading: true }
              : null
          }
        />
      )}
    </div>
  );
}

export function ActivationPanel() {
  const [s, a] = useExplorer([
    "analysisText",
    "inf",
    "infFilters",
    "tokenWeights",
    "fireResults",
  ]);
  return (
    <div className="tool-pane">
      <form
        className="space-y-3 border-b p-4"
        onSubmit={(event) => {
          event.preventDefault();
          a.safe(a.analyzeText(s.analysisText));
        }}
      >
        <div>
          <h3 className="text-sm font-medium">Analyze text</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Find which neurons respond to a passage, then select a token to
            inspect its activity.
          </p>
        </div>
        <Textarea
          id="inf-text"
          name="analysis-text"
          rows={4}
          aria-label="Text to analyze"
          value={s.analysisText}
          onChange={(event) => a.set({ analysisText: event.target.value })}
          placeholder="Paste a passage to analyze…"
          spellCheck={false}
        />
        <Button
          type="submit"
          disabled={
            s.analysisText.trim().length < 2 || Boolean(s.fireResults?.loading)
          }
        >
          {s.fireResults?.loading ? "Analyzing…" : "Analyze text"}
        </Button>
        {s.inf.text && s.analysisText.trim() !== s.inf.text ? (
          <p className="text-xs text-muted-foreground">
            Results below are for the previously analyzed passage. Run again to
            apply your changes.
          </p>
        ) : null}
      </form>
      {s.inf.tokens.length ? (
        <div id="infer" className="space-y-3 border-b p-4">
          <div id="inf-toks" onPointerLeave={() => a.previewToken(null)}>
            {s.inf.tokens.map((token, index) => {
              const position = s.inf.positions[index],
                selected = s.inf.pos === position,
                weight = s.tokenWeights[index];
              return (
                <Toggle
                  size="sm"
                  key={`${position}/${index}`}
                  pressed={selected}
                  aria-label={`Inspect token ${position}: ${token}`}
                  onPressedChange={() => a.pinToken(position)}
                  onPointerEnter={() => a.previewToken(position)}
                  style={
                    weight == null || selected
                      ? undefined
                      : {
                          background: `rgba(${weight >= 0 ? "255,181,71" : "255,79,154"},${Math.min(0.85, Math.abs(weight) * 1.6)})`,
                          color: Math.abs(weight) > 0.3 ? "#000" : undefined,
                        }
                  }
                >
                  {token}
                </Toggle>
              );
            })}
          </div>
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              Filter activations
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <div className="flex items-center gap-2">
                <label className="text-xs" htmlFor="inf-lo">
                  Layers
                </label>
                <Input
                  id="inf-lo"
                  className="w-16"
                  inputMode="numeric"
                  aria-label="from layer"
                  value={s.infFilters.lo}
                  onChange={(event) =>
                    a.filterInference({ lo: event.target.value })
                  }
                />
                <span>–</span>
                <Input
                  className="w-16"
                  inputMode="numeric"
                  aria-label="to layer"
                  value={s.infFilters.hi}
                  onChange={(event) =>
                    a.filterInference({ hi: event.target.value })
                  }
                />
              </div>
              <Segmented
                id="inf-sign"
                value={s.inf.sign}
                label="Activation sign"
                options={[
                  { value: "both", text: "Both signs" },
                  { value: "+", text: "Positive" },
                  { value: "-", text: "Negative" },
                ]}
                onChange={a.setSign}
              />
              <Field>
                <FieldLabel htmlFor="inf-min">Minimum score</FieldLabel>
                <Input
                  inputMode="decimal"
                  id="inf-min"
                  value={s.infFilters.min}
                  onChange={(event) =>
                    a.filterInference({ min: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="inf-query">
                  Token association contains
                </FieldLabel>
                <Input
                  id="inf-query"
                  value={s.infFilters.q}
                  onChange={(event) =>
                    a.filterInference({ q: event.target.value })
                  }
                  placeholder="Filter associations…"
                />
              </Field>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
      {s.fireResults ? (
        <ResultRows id="activation-results" results={s.fireResults} />
      ) : (
        <Slot>Paste a passage above to explore token-by-token activity.</Slot>
      )}
    </div>
  );
}
