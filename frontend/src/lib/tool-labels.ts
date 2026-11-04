const labels: Record<string, string> = {
  overview: "Model overview",
  neuron: "Neuron inspection",
  head: "Attention head inspection",
  search_lens: "Neuron search",
  top_units: "Top units",
  top_firing: "Active neurons",
  cone: "Connection trace",
  web_summary: "Circuit analysis",
  neuron_heads: "Connected attention heads",
  compare: "Activation comparison",
  logprobs: "Token probability comparison",
  steer: "Steering test",
  activations: "Activation measurement",
  run_shell: "Shell command",
  present_findings: "Investigation findings",
};

const shortName = (name: string) => name.split("__").at(-1) || name;
export function toolLabel(name: string) {
  const key = shortName(name);
  const readable = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return (
    labels[key] ||
    readable.charAt(0).toUpperCase() + readable.slice(1) ||
    "Tool"
  );
}
