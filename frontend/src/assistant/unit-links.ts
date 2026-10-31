import type { SelectionContext } from "../types";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

// Link references in prose after Markdown parsing. Existing links and code remain literal.
export function remarkUnitLinks(valid: (unit: SelectionContext) => boolean) {
  return () => (tree: MarkdownNode) => {
    function visit(parent: MarkdownNode) {
      if (!parent.children || ["link", "linkReference"].includes(parent.type))
        return;
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== "text" || !node.value) {
          visit(node);
          return [node];
        }
        const text = node.value;
        const parts: MarkdownNode[] = [];
        let cursor = 0;
        for (const match of text.matchAll(
          /(^|[^\w/])(L(\d+)[ /]([Nh])(\d+))\b/g,
        )) {
          const unit: SelectionContext = {
            layer: Number(match[3]),
            n: Number(match[5]),
            kind: match[4] === "h" ? "head" : "neuron",
          };
          if (!valid(unit)) continue;
          const start = match.index + match[1].length;
          if (start > cursor)
            parts.push({ type: "text", value: text.slice(cursor, start) });
          parts.push({
            type: "link",
            url: `#L${unit.layer}/${match[4]}${unit.n}`,
            children: [{ type: "text", value: match[2] }],
          });
          cursor = start + match[2].length;
        }
        if (!parts.length) return [node];
        if (cursor < text.length)
          parts.push({ type: "text", value: text.slice(cursor) });
        return parts;
      });
    }
    visit(tree);
  };
}
