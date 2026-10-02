import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type ToggleGroup03Option = {
  value: string;
  label: ReactNode;
};

export type ToggleGroup03Props = {
  ariaLabel: string;
  options: readonly ToggleGroup03Option[];
  value: string;
  onValueChange: (value: string) => void;
};

export function ToggleGroup03({
  ariaLabel,
  options,
  value,
  onValueChange,
}: ToggleGroup03Props) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      value={[value]}
      onValueChange={(nextValues) => {
        const nextValue = nextValues[0];
        if (nextValue !== undefined) onValueChange(nextValue);
      }}
      size="default"
      spacing={0}
      className="shrink-0 gap-0 overflow-hidden rounded border border-app-border bg-app-bg"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="!rounded-none h-[30px] border border-transparent bg-app-bg px-3 py-1 text-app-label text-app-text/90 font-medium transition-colors hover:bg-muted hover:text-app-text aria-pressed:border-app-accent aria-pressed:bg-app-bg aria-pressed:text-app-accent"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
