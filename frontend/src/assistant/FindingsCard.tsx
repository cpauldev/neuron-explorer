import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../components/ui/collapsible";
import { readFindings, findingsMarkdown } from "./research";
import { UnitLink } from "./SelectionContext";
import { useExplorer } from "../context";
import { Button } from "../components/ui/button";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import {
  CopyIcon,
  CheckIcon,
  FocusIcon,
  DownloadIcon,
  ChevronDownIcon,
} from "lucide-react";
import { ToolFallback } from "../components/tool-fallback.aui";
import Markdown from "react-markdown";

function ReportText({ text }: { text: string }) {
  return (
    <div className="space-y-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-foreground [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1">
      <Markdown
        skipHtml
        allowedElements={["p", "code", "strong", "em", "br", "ul", "ol", "li"]}
        unwrapDisallowed
      >
        {text}
      </Markdown>
    </div>
  );
}

export const FindingsCard: ToolCallMessagePartComponent = (props) => {
  const report = readFindings(props.result);
  const [, a] = useExplorer([]);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  if (!report) return <ToolFallback {...props} />;
  const references = report.references.filter((unit) =>
    unit.kind === "head"
      ? a.validHead(unit.layer, unit.n)
      : a.validNeuron(unit.layer, unit.n),
  );
  const highlightNeurons = references
    .filter((unit) => unit.kind === "neuron")
    .map(({ layer, n }) => ({ layer, n, sign: "+" as const }));
  return (
    <section
      aria-label="Investigation findings"
      className="my-3 space-y-3"
      data-slot="investigation-findings"
    >
      <div>
        <h3 className="text-lg font-medium">{report.title}</h3>
      </div>
      <div className="text-sm leading-relaxed">
        <ReportText text={report.summary} />
      </div>
      {report.caveats.length ? (
        <div className="space-y-2 text-sm leading-relaxed">
          <h4 className="font-medium">What remains uncertain</h4>
          {report.caveats.map((text, i) => (
            <ReportText key={i} text={text} />
          ))}
        </div>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger
          render={<Button variant="ghost" size="sm" className="group" />}
        >
          Evidence{" "}
          <ChevronDownIcon
            aria-hidden="true"
            className="transition-transform group-data-open:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          {report.evidence.map((entry, i) => (
            <section className="space-y-1 text-sm leading-relaxed" key={i}>
              <h4 className="text-xs font-medium text-muted-foreground">
                {entry.kind === "observation"
                  ? "Observation"
                  : "Interpretation"}{" "}
                · {entry.source}
              </h4>
              <ReportText text={entry.text} />
            </section>
          ))}
          <p className="text-xs text-muted-foreground">
            Agent assessment · {report.confidence} confidence
          </p>
        </CollapsibleContent>
      </Collapsible>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyToClipboard(findingsMarkdown(report))}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy findings"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([findingsMarkdown(report)], { type: "text/markdown" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "neuron-findings.md";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <DownloadIcon />
          Save report
        </Button>
        {highlightNeurons.length ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              a.safe(
                a.agentUi({ action: "highlight", neurons: highlightNeurons }),
              )
            }
          >
            <FocusIcon />
            Highlight referenced neurons
          </Button>
        ) : null}
      </div>
      {references.length ? (
        <div
          className="flex flex-wrap gap-x-3 gap-y-2 text-xs"
          aria-label="Referenced units"
        >
          {references.map((unit, i) => (
            <UnitLink key={`${unit.layer}/${unit.n}/${i}`} unit={unit} />
          ))}
        </div>
      ) : null}
    </section>
  );
};
