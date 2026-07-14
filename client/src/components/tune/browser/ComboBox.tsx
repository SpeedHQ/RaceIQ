import { useMemo, useState } from "react";
import { m } from "@/paraglide/messages";

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
  variant?: "track" | "car";
}

export function ComboBox({ label, value, options, onChange, placeholder, variant = "track" }: ComboBoxProps) {
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
      <div className={`text-[9px] tracking-[0.14em] uppercase mb-1.5 ${variant === "track" ? "text-app-accent" : "text-app-text-muted"}`}>{label}</div>
      <div className={`flex items-center gap-2.5 bg-app-surface border rounded-lg px-3.5 py-3 ${open ? "border-app-accent rounded-b-none" : "border-app-border-input"}`}>
        <span className="text-app-accent text-sm leading-none">⌕</span>
        <input
          type="text"
          value={open ? query : current}
          placeholder={placeholder}
          autoComplete="off"
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
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-app-text text-[15px] font-semibold placeholder:text-app-text-dim placeholder:font-normal"
        />
      </div>
      {open && (
        <div className="absolute top-full left-0 right-0 z-30 bg-app-surface border border-t-0 border-app-accent rounded-b-lg max-h-64 overflow-auto shadow-lg">
          {filtered.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o.value)}
              className={`flex items-center gap-2.5 w-full text-left px-3.5 py-2.5 border-t border-app-border ${i === hi ? "bg-app-surface-alt" : "hover:bg-app-surface-alt"}`}
            >
              <span className={`flex-1 truncate text-sm font-semibold ${o.value === value ? "text-app-accent" : "text-app-text"}`}>{o.label}</span>
              {o.count != null && (
                <span className="text-[11px] text-app-text-muted whitespace-nowrap">
                  <b className="text-app-text">{o.count}</b> {m.browser_tunes()}
                </span>
              )}
            </button>
          ))}
          {filtered.length === 0 && <div className="px-3.5 py-2.5 text-xs text-app-text-dim">{m.browser_no_match()}</div>}
        </div>
      )}
    </div>
  );
}
