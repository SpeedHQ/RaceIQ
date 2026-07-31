import { Popover } from "@base-ui/react/popover";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { m } from "@/paraglide/messages";

interface SearchSelectOption {
  value: string;
  label: string;
  group?: string; // optional group header label
  disabled?: boolean; // shown but not selectable
}

interface SearchSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  focusColor?: string; // e.g. "orange-500", "blue-500"
  fallbackLabel?: string; // shown when value is set but no option matches
}

const OVERLAY_SURFACE_CLASS = "rounded-lg border border-app-border-input bg-app-surface-alt text-app-text shadow-lg";
const OVERLAY_ITEM_CLASS = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors";

export function SearchSelect({ id, value, onChange, options, placeholder = "Search...", disabled = false, className = "", focusColor, fallbackLabel }: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId().replace(/:/g, "");
  const [highlightIdx, setHighlightIdx] = useState(-1);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? fallbackLabel ?? "";
  const filtered = search ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())) : options;

  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
    inputRef.current?.blur();
  }, []);

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      close();
    },
    [close, onChange],
  );

  useEffect(() => {
    const selectedIndex = filtered.findIndex((option) => option.value === value && !option.disabled);
    setHighlightIdx(selectedIndex);
  }, [search, open, value]);

  const moveHighlight = (direction: 1 | -1) => {
    if (filtered.length === 0) return;
    const start = highlightIdx < 0 ? (direction === 1 ? -1 : filtered.length) : highlightIdx;
    for (let offset = 1; offset <= filtered.length; offset += 1) {
      const index = (start + direction * offset + filtered.length) % filtered.length;
      if (!filtered[index]?.disabled) {
        setHighlightIdx(index);
        return;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlightIdx(filtered.findIndex((option) => !option.disabled));
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlightIdx([...filtered].findLastIndex((option) => !option.disabled));
    } else if (e.key === "Enter" && highlightIdx >= 0 && filtered[highlightIdx] && !filtered[highlightIdx].disabled) {
      e.preventDefault();
      handleSelect(filtered[highlightIdx].value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const focusBorderClass = focusColor ? `focus-visible:border-${focusColor}` : "focus-visible:border-app-accent focus-visible:ring-1 focus-visible:ring-app-accent/30";

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true);
        } else {
          close();
        }
      }}
    >
      <div className={`relative ${className}`}>
      <input
        id={id}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && highlightIdx >= 0 ? `${listboxId}-${highlightIdx}` : undefined}
        value={open ? search : selectedLabel}
        onChange={(e) => {
          setSearch(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setSearch("");
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={`w-full rounded border border-app-border-input bg-app-surface-alt px-2 py-1.5 text-sm text-app-text placeholder:text-app-text-dim outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusBorderClass}`}
      />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-app-text-muted"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
      {open && !disabled && (
        <Popover.Portal>
          <Popover.Positioner anchor={inputRef} positionMethod="fixed" align="start" sideOffset={4} collisionPadding={8} className="z-[60] outline-none">
            <Popover.Popup
            id={listboxId}
            role="listbox"
            aria-label={placeholder}
            className={`w-[var(--anchor-width)] max-h-[min(15rem,var(--available-height))] max-w-[var(--available-width)] overflow-auto py-1 ${OVERLAY_SURFACE_CLASS}`}
          >
            {filtered.map((option, index) => {
              const showGroup = option.group && (index === 0 || filtered[index - 1]?.group !== option.group);
              const highlighted = index === highlightIdx;
              const selected = option.value === value;
              return (
                <div key={option.value}>
                  {showGroup && <div className="border-t border-app-border-input bg-app-surface px-3 py-1 text-xs font-medium text-app-text-muted first:border-t-0">{option.group}</div>}
                  <button
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={option.disabled}
                    data-highlighted={highlighted ? "" : undefined}
                    data-selected={selected ? "" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => !option.disabled && setHighlightIdx(index)}
                    onClick={() => handleSelect(option.value)}
                    className={`${OVERLAY_ITEM_CLASS} ${
                      option.disabled
                        ? "cursor-not-allowed text-app-text-dim opacity-50"
                        : highlighted
                          ? "bg-app-accent/20 text-app-text"
                          : selected
                            ? "text-app-accent"
                            : "text-app-text hover:bg-app-accent/10"
                    }`}
                  >
                    {option.label}
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && <div className="px-3 py-2 text-sm text-app-text-muted">{m.common_no_results()}</div>}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      )}
      </div>
    </Popover.Root>
  );
}
