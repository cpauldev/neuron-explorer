import type { ComponentProps } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/** Shared composition for finite choices; searchable model catalogs use Combobox. */
export function ChoiceSelect<T extends string | number>({
  value,
  onValueChange,
  options,
  disabled,
  name,
  ...trigger
}: Omit<
  ComponentProps<typeof SelectTrigger>,
  "value" | "onValueChange" | "children"
> & {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  name?: string;
}) {
  return (
    <Select
      value={value}
      items={options}
      name={name}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
      }}
    >
      <SelectTrigger {...trigger}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="w-max min-w-(--anchor-width) max-w-[min(28rem,calc(100vw-2rem))]"
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
