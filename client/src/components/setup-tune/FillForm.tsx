import { useState } from "react";
import {
  type FieldDef,
  type SectionDef,
  arityLabels,
  arityLength,
  getByPath,
  setByPath,
} from "./setup-schema";

// Renders each setup section as a collapsible card with numeric inputs.
// `settings` is the source of truth; every edit calls `onChange` with a
// cloned-and-patched object so unknown keys in the original are preserved.

function cloneObj(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj));
}

function parseNum(s: string): number | "" {
  if (s.trim() === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? n : "";
}

function displayValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return "";
}

function ScalarInput({
  field,
  settings,
  onChange,
}: {
  field: FieldDef;
  settings: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const value = getByPath(settings, field.path);
  return (
    <label className="space-y-1 block">
      <span className="text-xs font-medium text-app-text-muted">{field.label}</span>
      <input
        type="number"
        step={field.step ?? "any"}
        value={displayValue(value)}
        onChange={(e) => {
          const n = parseNum(e.target.value);
          const next = cloneObj(settings);
          setByPath(next, field.path, n === "" ? undefined : n);
          onChange(next);
        }}
        className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
      />
      {field.hint && <span className="text-[10px] text-app-text-muted">{field.hint}</span>}
    </label>
  );
}

function ArrayInput({
  field,
  settings,
  onChange,
}: {
  field: FieldDef;
  settings: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const len = arityLength(field.arity);
  const labels = arityLabels(field.arity);
  const raw = getByPath(settings, field.path);
  const arr: unknown[] = Array.isArray(raw) ? raw : [];

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-app-text-muted">{field.label}</span>
        {field.hint && <span className="text-[10px] text-app-text-muted">{field.hint}</span>}
      </div>
      <div className={`grid gap-2 ${len === 4 ? "grid-cols-4" : "grid-cols-2"}`}>
        {Array.from({ length: len }).map((_, i) => (
          <label key={i} className="space-y-0.5 block">
            <span className="text-[10px] text-app-text-muted">{labels[i]}</span>
            <input
              type="number"
              step={field.step ?? "any"}
              aria-label={`${field.label} ${labels[i]}`}
              value={displayValue(arr[i])}
              onChange={(e) => {
                const n = parseNum(e.target.value);
                const nextArr = [...arr];
                while (nextArr.length < len) nextArr.push(0);
                nextArr[i] = n === "" ? 0 : n;
                const next = cloneObj(settings);
                setByPath(next, field.path, nextArr.slice(0, len));
                onChange(next);
              }}
              className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function SectionCard({
  section,
  settings,
  onChange,
  defaultOpen,
}: {
  section: SectionDef;
  settings: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const present = getByPath(settings, section.key);
  const hasData = present != null && typeof present === "object";

  return (
    <div className="rounded-lg ring-1 ring-app-border bg-app-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-app-text">{section.label}</span>
          <span
            className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${
              hasData ? "bg-emerald-500/20 text-emerald-400" : "bg-app-bg text-app-text-muted"
            }`}
          >
            {hasData ? "set" : "—"}
          </span>
        </div>
        <span className="text-app-text-muted text-xs">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-app-border">
          {section.fields.map((f) =>
            f.arity === "scalar" ? (
              <ScalarInput key={f.path} field={f} settings={settings} onChange={onChange} />
            ) : (
              <ArrayInput key={f.path} field={f} settings={settings} onChange={onChange} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function FillForm({
  sections,
  settings,
  onChange,
}: {
  sections: SectionDef[];
  settings: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="col-span-2 space-y-2">
      {sections.map((s, i) => (
        <SectionCard
          key={s.key}
          section={s}
          settings={settings}
          onChange={onChange}
          defaultOpen={i === 0}
        />
      ))}
    </div>
  );
}
