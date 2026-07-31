import { Popover } from "@base-ui/react/popover";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { m } from "@/paraglide/messages";

export interface SearchMultiSelectOption<K extends string | number = string | number> {
  key: K;
  label: string;
  search?: string;
}

interface Props<K extends string | number> {
  buttonLabel: string;
  options: SearchMultiSelectOption<K>[];
  isSelected: (key: K) => boolean;
  onSelect: (key: K) => void;
  onClear?: () => void;
  mode?: "single" | "multi";
  searchPlaceholder?: string;
  renderItem?: (opt: SearchMultiSelectOption<K>, selected: boolean) => ReactNode;
  className?: string;
  menuWidthClass?: string;
  menuAlign?: "left" | "right";
}

const OVERLAY_SURFACE_CLASS = "rounded-lg border border-app-border-input bg-app-surface-alt text-app-text shadow-lg";
const OVERLAY_ITEM_CLASS = "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm outline-none transition-colors @3xl/workspace:py-1.5 @3xl/workspace:text-app-label";

export function SearchMultiSelect<K extends string | number>({
  buttonLabel,
  options,
  isSelected,
  onSelect,
  onClear,
  mode = "multi",
  searchPlaceholder = "Search...",
  renderItem,
  className = "",
  menuWidthClass = "w-64",
  menuAlign = "left",
}: Props<K>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId().replace(/:/g, "");

  const filtered = options.filter((o) => (o.search ?? o.label).toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    setHighlightIdx(filtered.length > 0 ? 0 : -1);
  }, [search, open]);

  useEffect(() => {
    if (open) searchInputRef.current?.focus();
  }, [open]);

  const handleSelect = (key: K) => {
    onSelect(key);
    if (mode === "single") {
      setOpen(false);
      setSearch("");
    }
  };

  const moveHighlight = (direction: 1 | -1) => {
    if (filtered.length === 0) return;
    setHighlightIdx((current) => (current < 0 ? (direction === 1 ? 0 : filtered.length - 1) : (current + direction + filtered.length) % filtered.length));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter" && highlightIdx >= 0 && filtered[highlightIdx]) {
      event.preventDefault();
      handleSelect(filtered[highlightIdx].key);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setSearch("");
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <div ref={ref} className={`relative ${className}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-haspopup="listbox"
          onClick={() => {
            setOpen((current) => !current);
            setSearch("");
          }}
          className="flex items-center gap-1.5 rounded border border-app-border-input px-3 py-2 text-sm text-app-text-secondary outline-none transition-colors hover:text-app-text focus-visible:border-app-accent focus-visible:ring-1 focus-visible:ring-app-accent/30 @3xl/workspace:px-2 @3xl/workspace:py-0.5 @3xl/workspace:text-app-compact"
        >
          {buttonLabel}
          <svg aria-hidden="true" className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {onClear && (
          <button type="button" aria-label="Clear selection" onClick={onClear} className="px-2 py-2 text-sm text-app-text-dim outline-none transition-colors hover:text-app-text focus-visible:text-app-text @3xl/workspace:px-1 @3xl/workspace:py-0.5 @3xl/workspace:text-app-compact">
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
      {open && (
        <Popover.Portal>
          <Popover.Positioner
            anchor={ref}
            positionMethod="fixed"
            align={menuAlign === "right" ? "end" : "start"}
            sideOffset={4}
            collisionPadding={8}
            className="z-[60] outline-none"
          >
            <Popover.Popup
            id={listboxId}
            role="listbox"
            aria-label={searchPlaceholder}
            className={`max-h-[min(12rem,var(--available-height))] max-w-[var(--available-width)] overflow-hidden ${menuWidthClass} ${OVERLAY_SURFACE_CLASS}`}
          >
            <div className="border-b border-app-border-input p-1.5">
              <input
                ref={searchInputRef}
                type="search"
                aria-controls={listboxId}
                aria-activedescendant={highlightIdx >= 0 ? `${listboxId}-${highlightIdx}` : undefined}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="w-full rounded border border-app-border-input bg-app-surface px-2 py-2 text-sm text-app-text outline-none transition-colors placeholder:text-app-text-dim focus-visible:border-app-accent focus-visible:ring-1 focus-visible:ring-app-accent/30 @3xl/workspace:py-1 @3xl/workspace:text-app-label"
              />
            </div>
            <div className="max-h-48 overflow-y-auto py-1">
              {filtered.map((opt, index) => {
                const selected = isSelected(opt.key);
                const highlighted = index === highlightIdx;
                return (
                  <button
                    key={opt.key}
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-highlighted={highlighted ? "" : undefined}
                    data-selected={selected ? "" : undefined}
                    onMouseEnter={() => setHighlightIdx(index)}
                    onClick={() => handleSelect(opt.key)}
                    className={`${OVERLAY_ITEM_CLASS} ${highlighted ? "bg-app-accent/20 text-app-text" : selected ? "text-app-text" : "text-app-text-secondary hover:bg-app-accent/10"}`}
                  >
                    {mode === "multi" && (
                      <span className={`flex size-3.5 shrink-0 items-center justify-center rounded border ${selected ? "border-app-accent bg-app-accent" : "border-app-border-input"}`}>
                        {selected && (
                          <svg aria-hidden="true" className="size-2.5 text-app-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                    )}
                    {renderItem ? renderItem(opt, selected) : <span className="truncate">{opt.label}</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && <div className="px-3 py-2 text-sm text-app-text-muted">{m.common_no_results()}</div>}
            </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      )}
      </div>
    </Popover.Root>
  );
}
