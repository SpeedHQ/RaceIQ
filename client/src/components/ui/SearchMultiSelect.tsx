import { useEffect, useRef, useState, type ReactNode } from "react";

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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = options.filter((o) =>
    (o.search ?? o.label).toLowerCase().includes(search.toLowerCase()),
  );

  const handleSelect = (key: K) => {
    onSelect(key);
    if (mode === "single") {
      setOpen(false);
      setSearch("");
    }
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <div className="flex items-center gap-1">
        <button
          onClick={() => { setOpen((o) => !o); setSearch(""); }}
          className="text-sm md:text-app-unit px-3 py-2 md:px-2 md:py-0.5 rounded border border-app-border-input text-app-text-secondary hover:text-app-text flex items-center gap-1.5"
        >
          {buttonLabel}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {onClear && (
          <button
            onClick={onClear}
            className="text-sm md:text-app-unit text-app-text-dim hover:text-app-text px-2 py-2 md:px-1 md:py-0.5"
          >
            ✕
          </button>
        )}
      </div>
      {open && (
        <div className={`absolute ${menuAlign === "right" ? "right-0 md:right-auto md:left-0" : "left-0"} top-full mt-1 ${menuWidthClass} max-w-[calc(100vw-2rem)] bg-app-surface-alt border border-app-border-input rounded-lg shadow-lg z-50`}>
          <div className="p-1.5 border-b border-app-border-input">
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-app-surface border border-app-border-input rounded px-2 py-2 md:py-1 text-sm md:text-app-label text-app-text placeholder:text-app-text-dim focus:outline-none"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.map((opt) => {
              const selected = isSelected(opt.key);
              return (
                <button
                  key={opt.key}
                  onClick={() => handleSelect(opt.key)}
                  className={`w-full text-left flex items-center gap-2 px-3 py-2.5 md:py-1.5 text-sm md:text-app-label transition-colors hover:bg-app-surface ${selected ? "text-app-text" : "text-app-text-secondary"}`}
                >
                  {mode === "multi" && (
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${selected ? "bg-app-accent border-app-accent" : "border-app-border-input"}`}>
                      {selected && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  )}
                  {renderItem ? renderItem(opt, selected) : <span className="truncate">{opt.label}</span>}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-app-text-muted">No results</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
