import { useState } from "react";
import type { SetupContentSection, SetupContentRow } from "@raceiq/shared/racing/setups/content";
import { ToggleGroup03 } from "../shadcn-studio/toggle-group/toggle-group-03";
import { AppInput } from "../ui/AppInput";

const TAB_ORDER = ["Tyres", "Suspension", "Dampers", "Electronics", "Aero", "Fuel & strategy"];
const CORNER_ORDER = ["Front left", "Front right", "Rear left", "Rear right"];

function rowTab(label: string): string {
  const normalized = label.toLowerCase();
  if (/(tyre|pressure|camber|toe|caster|compound)/.test(normalized)) return "Tyres";
  if (normalized.includes("bumpstop") || normalized.includes("packer")) return "Suspension";
  if (/(bump|rebound|damper)/.test(normalized)) return "Dampers";
  return "Suspension";
}

function sectionTab(title: string): string {
  const normalized = title.toLowerCase();
  if (normalized.startsWith("aero")) return "Aero";
  if (normalized.startsWith("electronics")) return "Electronics";
  if (normalized.startsWith("fuel")) return "Fuel & strategy";
  if (["mechanical", "suspension", "front", "rear"].some((prefix) => normalized.startsWith(prefix))) return "Suspension";
  return title;
}

function sortTab(a: string, b: string): number {
  const aIndex = TAB_ORDER.indexOf(a);
  const bIndex = TAB_ORDER.indexOf(b);
  return (aIndex < 0 ? TAB_ORDER.length : aIndex) - (bIndex < 0 ? TAB_ORDER.length : bIndex);
}

function formatNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function SetupRow({ section, row, settings, originalKnobs, editing, onChange }: {
  section: string;
  row: SetupContentRow;
  settings?: Record<string, unknown>;
  originalKnobs?: Record<string, number>;
  editing: boolean;
  onChange?: (knob: string, value: number | undefined) => void;
}) {
  const knob = row.knob;
  const original = knob ? originalKnobs?.[knob] : undefined;
  const current = knob ? settings?.[knob] : undefined;
  const currentNumber = typeof current === "number" ? current : undefined;
  const changed = currentNumber !== undefined && currentNumber !== original;
  const cleared = knob !== undefined && settings !== undefined && currentNumber === undefined;
  const scale = row.scale ?? 1;
  const displayNumber = cleared ? undefined : changed ? currentNumber * scale : row.num;
  const value = cleared ? "" : changed
    ? `${formatNumber(currentNumber * scale)}${row.unit ?? ""}`
    : row.value;
  const canEdit = editing && !!knob && !row.fixed;

  return (
    <div
      className={`${editing ? "border-b border-app-border/50 py-1 last:border-0" : "text-xs"}${row.fixed ? " opacity-45" : ""}`}
      title={row.fixed ? "Fixed for this car — not adjustable in the in-game tune menu" : undefined}
    >
      <div className={editing ? "grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-3 text-xs" : "flex justify-between gap-2"}>
        <span className={editing ? "text-app-text-muted" : "whitespace-nowrap text-app-text-muted"}>{row.label}</span>
        {canEdit ? (
          <span className="relative min-w-0">
            <AppInput
              aria-label={`${section} ${row.label}${row.unit ? ` (${row.unit})` : ""}`}
              className="h-8 w-full min-w-0 py-1 pl-2 pr-12 text-right font-mono tabular-nums"
              type="number"
              step={row.step ?? "any"}
              value={currentNumber === undefined ? "" : formatNumber(currentNumber * scale)}
              onChange={(event) => {
                const { value: inputValue, valueAsNumber } = event.currentTarget;
                if (inputValue === "") onChange?.(knob!, undefined);
                else onChange?.(knob!, Number.isFinite(valueAsNumber) ? valueAsNumber / scale : undefined);
              }}
            />
            {row.unit && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2 flex w-8 items-center justify-end whitespace-nowrap text-xs text-app-text-muted">{row.unit}</span>}
          </span>
        ) : (
          <span className="whitespace-nowrap font-mono text-app-text">{value}</span>
        )}
      </div>
      {displayNumber !== undefined && row.min != null && row.max != null && row.max > row.min && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-app-caption font-mono tabular-nums text-muted-foreground">{row.min}</span>
          <div className="relative h-1 flex-1 rounded bg-muted">
            <span
              className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded bg-(--focus-setup)"
              style={{ left: `${Math.min(100, Math.max(0, ((displayNumber - row.min) / (row.max - row.min)) * 100))}%` }}
            />
          </div>
          <span className="text-app-caption font-mono tabular-nums text-muted-foreground">{row.max}</span>
        </div>
      )}
    </div>
  );
}

export function SetupSections({ sections, settings, originalKnobs, onChange }: {
  sections: readonly SetupContentSection[];
  settings?: Record<string, unknown>;
  originalKnobs?: Record<string, number>;
  onChange?: (knob: string, value: number | undefined) => void;
}) {
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const editing = settings !== undefined && onChange !== undefined;
  const allCorners = [...sections]
    .filter((section) => CORNER_ORDER.includes(section.title))
    .sort((a, b) => CORNER_ORDER.indexOf(a.title) - CORNER_ORDER.indexOf(b.title));
  const allOthers = sections.filter((section) => !CORNER_ORDER.includes(section.title));
  const tabs: string[] = [];
  const seen: Record<string, true> = {};
  const pushTab = (tab: string) => {
    if (seen[tab]) return;
    seen[tab] = true;
    tabs.push(tab);
  };
  for (const section of allCorners) for (const row of section.rows) pushTab(rowTab(row.label));
  for (const section of allOthers) pushTab(sectionTab(section.title));
  tabs.sort(sortTab);

  const tab = activeTab && tabs.includes(activeTab) ? activeTab : tabs[0] ?? "";
  const corners = allCorners
    .map((section) => ({ ...section, rows: section.rows.filter((row) => rowTab(row.label) === tab) }))
    .filter((section) => section.rows.length > 0);
  const others = allOthers.filter((section) => sectionTab(section.title) === tab);

  const card = (section: SetupContentSection, masonry = false) => (
    <div key={section.title} className={editing ? "min-w-0 rounded-xl border border-app-border p-3" : `${masonry ? "mb-3 break-inside-avoid " : ""}rounded-lg bg-app-bg p-3`}>
      <h4 className={editing ? "mb-2 text-sm font-semibold text-app-text" : "mb-2 text-xs font-semibold uppercase tracking-wider text-app-accent"}>{section.title}</h4>
      <div className={editing ? "" : "space-y-0.5"}>
        {section.rows.map((row) => (
          <SetupRow
            key={row.label}
            section={section.title}
            row={row}
            settings={settings}
            originalKnobs={originalKnobs}
            editing={editing}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="@container/setup-file min-w-0 space-y-4">
      <div className="min-w-0 overflow-x-auto">
        <ToggleGroup03
          ariaLabel="Setup sections"
          value={tab}
          onValueChange={setActiveTab}
          options={tabs.map((item) => ({ value: item, label: item }))}
        />
      </div>
      <section aria-label={tab} className={editing ? "space-y-4 pt-4" : "space-y-3"}>
          {tab === "Aero" && others.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 @xl/setup-file:grid-cols-2">
              {(() => {
                const rows = others.flatMap((section) => section.rows);
                return [
                  card({ title: "Rear", rows: rows.filter((row) => /rear|wing/i.test(row.label)) }),
                  card({ title: "Front", rows: rows.filter((row) => !/rear|wing/i.test(row.label)) }),
                ];
              })()}
            </div>
          ) : tab === "Suspension" ? (
            <div className="flex flex-col gap-3">
              {(() => {
                const rear = others.filter((section) => /rear/i.test(section.title));
                const front = others.filter((section) => !/rear/i.test(section.title));
                return <>
                  {front.map((section) => card(section))}
                  {corners.length > 0 && <div className="grid grid-cols-1 content-start gap-4 @xl/setup-file:grid-cols-2">{corners.map((section) => card(section))}</div>}
                  {rear.map((section) => card(section))}
                </>;
              })()}
            </div>
          ) : (
            <div className="flex flex-col gap-4 @5xl/setup-file:flex-row @5xl/setup-file:items-start">
              {corners.length > 0 && <div className={`grid min-w-0 grid-cols-1 content-start gap-4 @xl/setup-file:grid-cols-2 ${others.length > 0 ? "@5xl/setup-file:w-1/2" : "w-full"}`}>{corners.map((section) => card(section))}</div>}
              {others.length > 0 && <div className={editing ? "grid w-full min-w-0 grid-cols-1 content-start gap-4 @xl/setup-file:grid-cols-2" : "w-full min-w-0 columns-1 gap-3 @3xl/setup-file:columns-2"}>{others.map((section) => card(section, !editing))}</div>}
            </div>
          )}
      </section>
    </div>
  );
}
