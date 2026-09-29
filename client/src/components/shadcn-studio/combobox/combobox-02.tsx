"use client";

import { useMemo, useState } from "react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export interface Combobox02Option {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

export interface Combobox02Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: Combobox02Option[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  fallbackLabel?: string;
}

interface OptionGroup {
  value: string;
  items: Combobox02Option[];
}

function groupOptions(options: Combobox02Option[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  for (const option of options) {
    const groupName = option.group ?? "";
    let group = groups.at(-1);
    if (!group || group.value !== groupName) {
      group = { value: groupName, items: [] };
      groups.push(group);
    }
    group.items.push(option);
  }
  return groups;
}

export function Combobox02({
  id,
  value,
  onChange,
  options,
  placeholder = m.sessions_search_placeholder(),
  ariaLabel,
  disabled = false,
  className = "w-full max-w-xs",
  fallbackLabel,
}: Combobox02Props) {
  const [open, setOpen] = useState(false);
  const optionsWithFallback = useMemo(() => {
    if (!value || options.some((option) => option.value === value) || !fallbackLabel) return options;
    return [...options, { value, label: fallbackLabel }];
  }, [fallbackLabel, options, value]);
  const groups = useMemo(() => groupOptions(optionsWithFallback), [optionsWithFallback]);
  const selectedOption = optionsWithFallback.find((option) => option.value === value) ?? null;
  const focusClass = "[&:has([data-slot=input-group-control]:focus-visible)]:border-app-accent";

  return (
    <Combobox
      open={open}
      onOpenChange={setOpen}
      openOnInputClick
      items={groups}
      value={selectedOption}
      disabled={disabled}
      onValueChange={(option) => {
        if (option && "value" in option && !("items" in option)) onChange(option.value);
      }}
    >
      <ComboboxInput
        id={id}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        disabled={disabled}
        showTrigger={false}
        onClick={() => setOpen(true)}
        className={cn("w-full border-app-border-input bg-transparent dark:bg-transparent [&_[data-slot=input-group-control]]:pr-8", focusClass, className)}
      >
        <button
          type="button"
          aria-label={open ? "Hide options" : "Show options"}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-app-text-muted hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </button>
      </ComboboxInput>
      <ComboboxContent className="border border-app-border-input bg-app-surface-alt text-app-text shadow-lg">
        <ComboboxEmpty>{m.common_no_results()}</ComboboxEmpty>
        <ComboboxList aria-label={placeholder}>
          {(group) => (
            <ComboboxGroup key={`${group.value}-${groups.indexOf(group)}`} items={group.items}>
              {group.value && <ComboboxLabel className="border-t border-app-border-input bg-app-surface px-3 py-1 text-app-text-muted first:border-t-0">{group.value}</ComboboxLabel>}
              <ComboboxCollection>
                {(option) => (
                  <ComboboxItem
                    key={option.value}
                    value={option}
                    disabled={option.disabled}
                    className="min-h-8 whitespace-normal px-3 py-1.5 leading-snug"
                  >
                    {option.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
