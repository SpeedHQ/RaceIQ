import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { m } from "@/paraglide/messages";
import { AppInput } from "./AppInput";
import { Button } from "./button";

interface SearchSelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

interface SearchSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  focusColor?: string;
  fallbackLabel?: string;
}

export function SearchSelect({ id, value, onChange, options, placeholder = "Search...", disabled = false, className = "", focusColor, fallbackLabel }: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listboxId = useId().replace(/:/g, "");
  const [panelRect, setPanelRect] = useState<{ top: number; left: number; width: number; above: boolean } | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(-1);

  const selectedLabel = options.find((option) => option.value === value)?.label ?? fallbackLabel ?? "";
  const filtered = useMemo(() => (search ? options.filter((option) => option.label.toLowerCase().includes(search.toLowerCase())) : options), [options, search]);

  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
    inputRef.current?.blur();
  }, []);

  const handleSelect = useCallback(
    (selectedValue: string) => {
      onChange(selectedValue);
      close();
    },
    [close, onChange],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelRect(null);
      return;
    }
    const updateRect = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxHeight = 240;
      const above = rect.bottom + maxHeight > window.innerHeight - 8 && rect.top > maxHeight + 8;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - rect.width - 8));
      setPanelRect({ top: above ? rect.top : rect.bottom, left, width: rect.width, above });
    };
    updateRect();
    const resizeObserver = new ResizeObserver(updateRect);
    resizeObserver.observe(document.documentElement);
    if (inputRef.current) resizeObserver.observe(inputRef.current);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [open]);

  useEffect(() => {
    const selectedIndex = filtered.findIndex((option) => option.value === value && !option.disabled);
    setHighlightIdx(selectedIndex);
  }, [filtered, open, value]);

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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlightIdx(filtered.findIndex((option) => !option.disabled));
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightIdx([...filtered].findLastIndex((option) => !option.disabled));
    } else if (event.key === "Enter" && highlightIdx >= 0 && filtered[highlightIdx] && !filtered[highlightIdx].disabled) {
      event.preventDefault();
      handleSelect(filtered[highlightIdx].value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const focusBorderClass = focusColor ? `focus-visible:border-${focusColor}` : "focus-visible:border-app-accent focus-visible:ring-1 focus-visible:ring-app-accent/30";

  return (
    <div ref={containerRef} className={`relative ${className}`}>
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
        onChange={(event) => {
          setSearch(event.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setSearch("");
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={`w-full bg-app-surface-alt ${focusBorderClass}`}
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
      {open &&
        !disabled &&
        panelRect &&
        createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            aria-label={placeholder}
            style={{
              position: "fixed",
              top: panelRect.top,
              left: panelRect.left,
              width: panelRect.width,
              ...(panelRect.above ? { transform: "translateY(calc(-100% - 4px))" } : { marginTop: 4 }),
            }}
            className={`z-[60] max-h-60 overflow-auto py-1 ${OVERLAY_SURFACE_CLASS}`}
          >
            {filtered.map((option, index) => {
              const showGroup = option.group && (index === 0 || filtered[index - 1]?.group !== option.group);
              const highlighted = index === highlightIdx;
              const selected = option.value === value;
              return (
                <div key={option.value}>
                  {showGroup && <div className="border-t border-app-border-input bg-app-surface px-3 py-1 text-xs font-medium text-app-text-muted first:border-t-0">{option.group}</div>}
                  <Button
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    variant="plain"
                    size="content"
                    aria-selected={selected}
                    disabled={option.disabled}
                    data-highlighted={highlighted ? "" : undefined}
                    data-selected={selected ? "" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => !option.disabled && setHighlightIdx(index)}
                    onClick={() => handleSelect(option.value)}
                    className={`${OVERLAY_ITEM_CLASS} ${
                      option.disabled ? "cursor-not-allowed text-app-text-dim opacity-50" : highlighted ? "bg-app-accent/20 text-app-text" : selected ? "text-app-accent" : "text-app-text"
                    }`}
                  >
                    {option.label}
                  </Button>
                </div>
              );
            })}
            {filtered.length === 0 && <div className="px-3 py-2 text-sm text-app-text-muted">{m.common_no_results()}</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}
