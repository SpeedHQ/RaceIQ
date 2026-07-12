import { useState, useRef, useEffect, useCallback } from "react";

interface SearchSelectOption {
  value: string;
  label: string;
  group?: string; // optional group header label
}

interface SearchSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  focusColor?: string; // e.g. "orange-500", "blue-500"
  fallbackLabel?: string; // shown when value is set but no option matches
}

export function SearchSelect({ value, onChange, options, placeholder = "Search...", disabled = false, className = "", focusColor, fallbackLabel }: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? fallbackLabel ?? "";

  const filtered = search ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())) : options;

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setSearch("");
      setOpen(false);
      inputRef.current?.blur();
    },
    [onChange],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Keyboard navigation
  const [highlightIdx, setHighlightIdx] = useState(-1);
  useEffect(() => {
    setHighlightIdx(-1);
  }, [search, open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0 && filtered[highlightIdx]) {
      e.preventDefault();
      handleSelect(filtered[highlightIdx].value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
      inputRef.current?.blur();
    }
  };

  const focusBorderClass = focusColor ? `focus:border-${focusColor}` : "focus:ring-1 focus:ring-app-border-input";

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
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
        className={`w-full bg-app-surface-alt border border-app-border-input rounded px-2 py-1.5 text-sm text-app-text placeholder:text-app-text-dim focus:outline-none disabled:opacity-50 text-ellipsis ${focusBorderClass}`}
      />
      {/* Chevron indicator */}
      <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-app-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
      {open && !disabled && (
        <div className="absolute left-0 right-0 mt-1 max-h-60 overflow-auto rounded-lg bg-app-surface-alt border border-app-border-input z-50 shadow-lg">
          {filtered.map((o, i) => {
            const showGroup = o.group && (i === 0 || filtered[i - 1]?.group !== o.group);
            return (
              <div key={o.value}>
                {showGroup && <div className="px-3 py-1 text-xs font-medium text-app-text-muted bg-app-surface border-t border-app-border-input first:border-t-0">{o.group}</div>}
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(o.value)}
                  className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                    i === highlightIdx ? "bg-app-accent/20 text-app-text" : o.value === value ? "text-app-accent" : "text-app-text hover:bg-app-accent/10"
                  }`}
                >
                  {o.label}
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && <div className="px-3 py-2 text-sm text-app-text-muted">No results</div>}
        </div>
      )}
    </div>
  );
}
