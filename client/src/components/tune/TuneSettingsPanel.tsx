import type { TuneSettings } from "../../data/tune-catalog";
import { GearRatioChart } from "./GearRatioChart";
import { m } from "@/paraglide/messages";

function storedHeightUnit(settings: TuneSettings): "cm" | "in" {
  return settings.springs?.unit === "lb/in" ? "in" : "cm";
}

type Row = [string, string];

/** Build a row only when the value is present; community tunes ship partial settings. */
function row(label: string, value: number | null | undefined, render: (v: number) => string): Row | null {
  return value == null ? null : [label, render(value)];
}

function rows(...items: (Row | null)[]): Row[] {
  return items.filter((r): r is Row => r != null);
}

export function TuneSettingsPanel({ settings }: { settings: TuneSettings }) {
  const ratios = settings.gearing?.ratios ?? [];
  const heightUnit = storedHeightUnit(settings);
  const springUnit = settings.springs?.unit ?? "kgf/mm";
  const aeroUnit = settings.aero?.unit ?? "kgf";

  const sectionTitles: Record<string, string> = {
    tires: m.tune_section_tires(),
    gearing: m.tune_section_gearing(),
    alignment: m.tune_section_alignment(),
    antiRollBars: m.tune_section_anti_roll_bars(),
    springs: m.tune_section_springs(),
    damping: m.tune_section_damping(),
    aero: m.tune_section_aero(),
    differential: m.tune_section_differential(),
    brakes: m.tune_section_brakes(),
  };

  const sections: { key: string; title: string; rows: Row[] }[] = [
    {
      key: "tires",
      title: sectionTitles.tires,
      rows: rows(
        row("Front Pressure", settings.tires?.frontPressure, (v) => `${v.toFixed(2)} bar`),
        row("Rear Pressure", settings.tires?.rearPressure, (v) => `${v.toFixed(2)} bar`),
      ),
    },
    {
      key: "gearing",
      title: sectionTitles.gearing,
      rows: [
        ...rows(row("Final Drive", settings.gearing?.finalDrive, (v) => v.toFixed(2))),
        ...ratios.map((ratio, index) => [`Gear ${index + 1}`, ratio.toFixed(2)] as Row),
        ...(settings.gearing?.description ? [["Notes", settings.gearing.description] as Row] : []),
      ],
    },
    {
      key: "alignment",
      title: sectionTitles.alignment,
      rows: rows(
        row("Front Camber", settings.alignment?.frontCamber, (v) => `${v.toFixed(1)}°`),
        row("Rear Camber", settings.alignment?.rearCamber, (v) => `${v.toFixed(1)}°`),
        row("Front Toe", settings.alignment?.frontToe, (v) => `${v.toFixed(1)}°`),
        row("Rear Toe", settings.alignment?.rearToe, (v) => `${v.toFixed(1)}°`),
        row("Front Caster", settings.alignment?.frontCaster, (v) => `${v.toFixed(1)}°`),
      ),
    },
    {
      key: "antiRollBars",
      title: sectionTitles.antiRollBars,
      rows: rows(
        row("Front", settings.antiRollBars?.front, (v) => v.toFixed(1)),
        row("Rear", settings.antiRollBars?.rear, (v) => v.toFixed(1)),
      ),
    },
    {
      key: "springs",
      title: sectionTitles.springs,
      rows: rows(
        row("Front Rate", settings.springs?.frontRate, (v) => `${v.toFixed(1)} ${springUnit}`),
        row("Rear Rate", settings.springs?.rearRate, (v) => `${v.toFixed(1)} ${springUnit}`),
        row("Front Height", settings.springs?.frontHeight, (v) => `${v.toFixed(1)} ${heightUnit}`),
        row("Rear Height", settings.springs?.rearHeight, (v) => `${v.toFixed(1)} ${heightUnit}`),
      ),
    },
    {
      key: "damping",
      title: sectionTitles.damping,
      rows: rows(
        row("Front Bump", settings.damping?.frontBump, (v) => v.toFixed(1)),
        row("Rear Bump", settings.damping?.rearBump, (v) => v.toFixed(1)),
        row("Front Rebound", settings.damping?.frontRebound, (v) => v.toFixed(1)),
        row("Rear Rebound", settings.damping?.rearRebound, (v) => v.toFixed(1)),
      ),
    },
    {
      key: "aero",
      title: sectionTitles.aero,
      rows: rows(
        row("Front Downforce", settings.aero?.frontDownforce, (v) => `${v} ${aeroUnit}`),
        row("Rear Downforce", settings.aero?.rearDownforce, (v) => `${v} ${aeroUnit}`),
      ),
    },
    {
      key: "differential",
      title: sectionTitles.differential,
      rows: rows(
        row("Rear Accel", settings.differential?.rearAccel, (v) => `${v}%`),
        row("Rear Decel", settings.differential?.rearDecel, (v) => `${v}%`),
        row("Front Accel", settings.differential?.frontAccel, (v) => `${v}%`),
        row("Front Decel", settings.differential?.frontDecel, (v) => `${v}%`),
        row("Center", settings.differential?.center, (v) => `${v}%`),
      ),
    },
    {
      key: "brakes",
      title: sectionTitles.brakes,
      rows: rows(
        row("Balance", settings.brakes?.balance, (v) => `${v}%`),
        row("Pressure", settings.brakes?.pressure, (v) => `${v}%`),
      ),
    },
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {sections
        .filter((section) => section.rows.length > 0)
        .map((section) => (
          <div key={section.key} className="rounded-lg bg-app-bg/85 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{section.title}</h4>
            <div className="space-y-0">
              {section.rows.map(([label, value]) => (
                <div key={label} className="flex justify-between text-xs gap-2">
                  <span className="text-app-text-muted whitespace-nowrap">{label}</span>
                  <span className="text-app-text font-mono whitespace-nowrap" style={label === "Notes" ? { whiteSpace: "normal", textAlign: "right" } : undefined}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
            {section.key === "gearing" && ratios.length > 0 && settings.gearing?.finalDrive != null && (
              <div className="mt-2 pt-2 border-t border-app-border/60">
                <GearRatioChart ratios={ratios} finalDrive={settings.gearing.finalDrive} topSpeedKph={settings.gearing?.topSpeedKph} />
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
