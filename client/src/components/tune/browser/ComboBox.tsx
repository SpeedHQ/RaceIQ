import { useMemo, useState } from "react";

export interface ComboOption {
  value: string;
  label: string;
  count?: number;
}
export interface ComboBoxProps {
  label: string;
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export function ComboBox({ label, value, options, onChange, placeholder }: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(-1);
  const current = options.find((o) => o.value === value)?.label ?? "";
  const filtered = useMemo(() => (query ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())) : options), [options, query]);
  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
    setHi(-1);
  };
  return (
    <div className="relative flex-1 min-w-0">
      <div className="text-[9px] tracking-[0.14em] text-app-accent mb-1.5 uppercase">{label}</div>
      <input
        type="text"
        value={open ? query : current}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            setHi((h) => Math.min(h + 1, filtered.length - 1));
            e.preventDefault();
          } else if (e.key === "ArrowUp") {
            setHi((h) => Math.max(h - 1, 0));
            e.preventDefault();
          } else if (e.key === "Enter" && filtered[hi]) {
            choose(filtered[hi].value);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="w-full bg-app-surface text-app-text text-sm font-semibold rounded-lg px-3 py-3 border border-app-border-input focus:outline-none focus:ring-1 focus:ring-app-accent"
      />
      {open && (
        <div className="absolute left-0 right-0 mt-1 max-h-64 overflow-auto rounded-lg bg-app-dropdown border border-app-border z-50 shadow-lg">
          {filtered.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o.value)}
              className={`w-full flex items-center gap-2 text-left px-3 py-2.5 text-sm transition-colors ${i === hi ? "bg-app-accent/20" : "hover:bg-app-accent/10"} ${o.value === value ? "text-app-accent" : "text-app-text"}`}
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.count != null && (
                <span className="text-xs text-app-text-muted">
                  <b className="text-app-text">{o.count}</b> tunes
                </span>
              )}
            </button>
          ))}
          {filtered.length === 0 && <div className="px-3 py-2 text-xs text-app-text-muted">No match</div>}
        </div>
      )}
    </div>
  );
}
