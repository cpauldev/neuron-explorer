import type { AssistantMessage, SelectionContext } from "../types";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function unpack(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
export interface Findings {
  title: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  evidence: {
    source: string;
    text: string;
    kind: "observation" | "interpretation";
  }[];
  caveats: string[];
  references: SelectionContext[];
  next_steps: { label: string; prompt: string }[];
}
export function readFindings(value: unknown): Findings | null {
  const v = unpack(value);
  if (
    !isRecord(v) ||
    typeof v.title !== "string" ||
    typeof v.summary !== "string" ||
    !["low", "medium", "high"].includes(String(v.confidence)) ||
    !Array.isArray(v.evidence) ||
    !v.evidence.length ||
    !v.evidence.every(
      (e) =>
        isRecord(e) &&
        typeof e.source === "string" &&
        typeof e.text === "string" &&
        ["observation", "interpretation"].includes(String(e.kind)),
    ) ||
    !Array.isArray(v.caveats) ||
    !v.caveats.every((c) => typeof c === "string") ||
    !Array.isArray(v.references) ||
    !v.references.every(
      (r) =>
        isRecord(r) &&
        Number.isInteger(r.layer) &&
        Number.isInteger(r.n) &&
        ["neuron", "head"].includes(String(r.kind)),
    ) ||
    !Array.isArray(v.next_steps) ||
    !v.next_steps.every(
      (n) =>
        isRecord(n) &&
        typeof n.label === "string" &&
        typeof n.prompt === "string",
    )
  )
    return null;
  return v as unknown as Findings;
}
export function latestFindings(messages: AssistantMessage[]) {
  const parts = messages.findLast((m) => m.role === "assistant")?.content || [];
  return (
    parts
      .flatMap((p) =>
        p.type === "tool-call" &&
        p.toolName.split("__").at(-1) === "present_findings" &&
        !p.isError
          ? [readFindings(p.result)]
          : [],
      )
      .findLast(Boolean) || null
  );
}

export function findingsMarkdown(report: Findings) {
  return [
    `# ${report.title}`,
    report.summary,
    `Agent assessment: ${report.confidence} confidence`,
    "## Evidence",
    ...report.evidence.map((e) => `- **${e.kind} · ${e.source}:** ${e.text}`),
    ...(report.caveats.length
      ? ["## Limitations", ...report.caveats.map((c) => `- ${c}`)]
      : []),
    ...(report.references.length
      ? [
          "## Referenced units",
          report.references
            .map((u) => `L${u.layer} ${u.kind === "head" ? "h" : "N"}${u.n}`)
            .join(", "),
        ]
      : []),
    ...(report.next_steps.length
      ? [
          "## Next steps",
          ...report.next_steps.map((n) => `- ${n.label}: ${n.prompt}`),
        ]
      : []),
  ].join("\n\n");
}
