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
    <div className={`tt-combo ${variant} ${open ? "open" : ""}`}>
      <div className="tt-fieldlbl">{label}</div>
      <div className="tt-field">
        <span className="tt-ico">⌕</span>
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
        />
      </div>
      <div className="tt-menu">
        {filtered.map((o, i) => (
          <button key={o.value} type="button" className={`tt-opt ${i === hi ? "hi" : ""} ${o.value === value ? "sel" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o.value)}>
            <span className="tt-optname">{o.label}</span>
            {o.count != null && (
              <span className="tt-cnt">
                <b>{o.count}</b> tunes
              </span>
            )}
          </button>
        ))}
        {filtered.length === 0 && <div className="tt-opt none">No match</div>}
      </div>
    </div>
  );
}
