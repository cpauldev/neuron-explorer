import type { ComponentProps } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
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
  onOpenChange,
  ...trigger
}: Omit<
  ComponentProps<typeof SelectTrigger>,
  "value" | "onValueChange" | "children"
> & {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string; title?: string }[];
  name?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Select
      value={value}
      items={options}
      name={name}
      disabled={disabled}
      onOpenChange={onOpenChange}
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
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              title={option.title}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
