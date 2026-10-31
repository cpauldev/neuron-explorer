import { useId, type ReactNode } from "react";
import type { Token } from "../types";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { InfoIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

function TokenFragment({
  text,
  bytes,
  count,
}: {
  text: string;
  bytes?: string;
  count?: number;
}) {
  const label = bytes ? "Byte fragment" : "Token fragment";
  const descriptionId = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="secondary"
            className="mr-1 mb-1 cursor-help"
            tabIndex={0}
            aria-label={`${label}: ${bytes || text}`}
            aria-describedby={descriptionId}
          />
        }
      >
        <InfoIcon aria-hidden="true" />
        {label}
        {count != null ? (
          <span className="text-muted-foreground">{count}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent
        id={descriptionId}
        role="tooltip"
        className="block leading-relaxed"
      >
        <p>
          {bytes
            ? "This token contains part of a character and needs adjacent tokens to become readable."
            : "This token cannot be displayed as a complete character on its own."}
        </p>
        <p className="mt-1 font-mono">
          {bytes ? `UTF-8 bytes: ${bytes}` : text}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function Segmented<T extends string>({
  id,
  value,
  options,
  onChange,
  label,
  title,
  disabled = false,
  dataKey,
}: {
  id: string;
  value: T;
  options: { value: T; text: ReactNode; label?: string; title?: string }[];
  onChange: (value: T) => void;
  label?: string;
  title?: string;
  disabled?: boolean;
  dataKey?: string;
}) {
  return (
    <ToggleGroup
      id={id}
      value={[value]}
      multiple={false}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label={label}
      title={title}
      onValueChange={(values) => {
        if (values.length) onChange(values[0] as T);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label || undefined}
          title={option.title}
          disabled={disabled}
          {...(dataKey ? { [`data-${dataKey}`]: option.value } : {})}
        >
          {option.text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
export function Slot({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`px-3 py-2 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}
      role="status"
    >
      {children}
    </div>
  );
}
export function Tokens({
  values = [],
  onSearch,
}: {
  values?: (string | Token)[];
  onSearch?: (token: string) => void;
}) {
  return values.map((value, i) => {
    const text = typeof value === "string" ? value : value.tok;
    const bytes = /^bytes:([0-9A-F]{2}(?: [0-9A-F]{2})*)$/.exec(text)?.[1];
    if (bytes || /^token:\d+ \(/.test(text))
      return (
        <TokenFragment
          key={`${text}-${i}`}
          text={text}
          bytes={bytes}
          count={typeof value === "string" ? undefined : value.n}
        />
      );
    return onSearch ? (
      <Button
        variant="secondary"
        size="xs"
        key={`${text}-${i}`}
        title={`Search ${text}`}
        onClick={() => onSearch(text.trim() || text)}
      >
        {text}
        {typeof value !== "string" && value.n != null ? (
          <span className="text-muted-foreground">{value.n}</span>
        ) : null}
      </Button>
    ) : (
      <Badge
        variant="secondary"
        className="mr-1 mb-1 font-mono"
        key={`${text}-${i}`}
      >
        {text}
      </Badge>
    );
  });
}
