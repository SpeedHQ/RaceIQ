import { type FieldDef, readSetupField, readSetupSection, type SectionDef, SETUP_FORM_TAB_ORDER, writeSetupField } from "@shared/racing/setups/schema";
import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

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

function ScalarInput({ field, settings, onChange }: { field: FieldDef; settings: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const value = readSetupField(settings, field);
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
          writeSetupField(next, field, n === "" ? undefined : n);
          onChange(next);
        }}
        className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
      />
      {field.hint && <span className="text-app-caption text-app-text-muted">{field.hint}</span>}
    </label>
  );
}

function ArrayInput({ field, settings, onChange }: { field: FieldDef; settings: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  if (field.cardinality.kind !== "fixed") throw new Error(`Expected fixed cardinality for ${field.path}`);
  const { count: len, ordering: labels } = field.cardinality;
  const raw = readSetupField(settings, field);
  const arr: unknown[] = Array.isArray(raw) ? raw : [];

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-app-text-muted">{field.label}</span>
        {field.hint && <span className="text-app-caption text-app-text-muted">{field.hint}</span>}
      </div>
      <div className={`grid gap-2 ${len === 4 ? "grid-cols-4" : "grid-cols-2"}`}>
        {labels.map((label, i) => (
          <label key={label} className="space-y-0.5 block">
            <span className="text-app-caption text-app-text-muted">{label}</span>
            <input
              type="number"
              step={field.step ?? "any"}
              aria-label={`${field.label} ${label}`}
              value={displayValue(arr[i])}
              onChange={(e) => {
                const n = parseNum(e.target.value);
                const nextArr = [...arr];
                while (nextArr.length < len) nextArr.push(0);
                nextArr[i] = n === "" ? 0 : n;
                const next = cloneObj(settings);
                writeSetupField(next, field, nextArr.slice(0, len));
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
  const present = readSetupSection(settings, section);
  const hasData = present != null && typeof present === "object";

  return (
    <Card size="sm" variant="form-section">
      <Button variant="form-section-toggle" size="app-md" onClick={() => setOpen((o) => !o)}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-app-text">{section.label}</span>
          <Badge variant={hasData ? "success" : "form-section-empty"} size="compact">
            {hasData ? "set" : "—"}
          </Badge>
        </div>
        <span className="text-xs text-app-text-muted">{open ? "▾" : "▸"}</span>
      </Button>
      {open && (
        <div className="space-y-3 border-t border-app-border px-3 pb-3 pt-1">
          {section.fields.map((field) =>
            field.cardinality.kind === "scalar" ? <ScalarInput key={field.path} field={field} settings={settings} onChange={onChange} /> : <ArrayInput key={field.path} field={field} settings={settings} onChange={onChange} />,
          )}
        </div>
      )}
    </Card>
  );
}

export function FillForm({ sections, settings, onChange }: { sections: readonly SectionDef[]; settings: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const tabs = SETUP_FORM_TAB_ORDER.map((label) => ({
    label,
    sections: sections.filter((section) => section.tab === label),
  })).filter((tab) => tab.sections.length > 0);

  const [active, setActive] = useState(0);
  const activeValue = tabs[Math.min(active, tabs.length - 1)]?.label;

  return (
    <div className="col-span-2 space-y-2">
      <Tabs
        value={activeValue}
        onValueChange={(value) => {
          const next = tabs.findIndex((t) => t.label === value);
          if (next >= 0) setActive(next);
        }}
      >
        <TabsList>
          {tabs.map((t) => {
            const hasData = t.sections.some((s) => {
              const present = readSetupSection(settings, s);
              return present != null && typeof present === "object";
            });
            return (
              <TabsTrigger key={t.label} value={t.label}>
                {t.label}
                {hasData && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-status-success align-middle" />}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.label} value={t.label} className="space-y-2">
            {t.sections.map((s) => (
              <SectionCard key={s.key} section={s} settings={settings} onChange={onChange} defaultOpen={true} />
            ))}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
