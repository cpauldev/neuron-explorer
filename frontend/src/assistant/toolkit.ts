import { defineToolkit } from "@assistant-ui/react";
import { FindingsCard } from "./FindingsCard";
import { ResearchToolResult } from "./ResearchToolResult";

const toolNames = [
  "neuron",
  "head",
  "search_lens",
  "top_units",
  "top_firing",
  "cone",
  "web_summary",
  "neuron_heads",
  "compare",
  "logprobs",
  "steer",
  "activations",
  "run_shell",
];
const toolEntries = Object.fromEntries(
  toolNames.flatMap((name) =>
    [name, `mcp__explorer__${name}`].map((key) => [
      key,
      { type: "backend" as const, render: ResearchToolResult },
    ]),
  ),
);
export const toolkit = defineToolkit({
  ...toolEntries,
  present_findings: {
    type: "backend",
    display: "standalone",
    render: FindingsCard,
  },
  mcp__explorer__present_findings: {
    type: "backend",
    display: "standalone",
    render: FindingsCard,
  },
});
