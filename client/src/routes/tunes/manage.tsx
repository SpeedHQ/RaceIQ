import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CATALOG_CARS,
  getCatalogCar,
  type TuneSettings,
} from "../../data/tune-catalog";
import type { Tune, TuneCategory } from "@shared/types";
import {
  useUserTunes,
  useCreateTune,
  useUpdateTune,
  useDeleteTune,
  useTuneAssignments,
  useDeleteTuneAssignment,
} from "../../hooks/queries";

function useAllCars() {
  return useQuery<{ ordinal: number; name: string }[]>({
    queryKey: ["all-cars"],
    queryFn: () => fetch("/api/cars").then((r) => r.json()),
    staleTime: Infinity,
  });
}

// ── Reused constants ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  circuit: "Circuit",
  wet: "Wet",
  "low-drag": "Low Drag",
  stable: "Stable",
  "track-specific": "Track Specific",
};

const CATEGORY_COLORS: Record<string, string> = {
  circuit: "bg-blue-500/20 text-blue-400",
  wet: "bg-cyan-500/20 text-cyan-400",
  "low-drag": "bg-red-500/20 text-red-400",
  stable: "bg-green-500/20 text-green-400",
  "track-specific": "bg-orange-500/20 text-orange-400",
};

const ALL_CATEGORIES: TuneCategory[] = [
  "circuit",
  "wet",
  "low-drag",
  "stable",
  "track-specific",
];

// ── Unit conversion ──────────────────────────────────────────────────────────

type UnitSystem = {
  tires: "bar" | "psi";
  springs: "kgf/mm" | "lb/in";
  height: "cm" | "in";
  aero: "kgf" | "lb";
};

const DEFAULT_UNITS: UnitSystem = { tires: "bar", springs: "kgf/mm", height: "cm", aero: "kgf" };

const CONVERSIONS = {
  tires:   { "bar": 1, "psi": 14.50377 },
  springs: { "kgf/mm": 1, "lb/in": 56.0 },
  height:  { "cm": 1, "in": 0.393701 },
  aero:    { "kgf": 1, "lb": 2.20462 },
} as const;

/** Convert from stored (bar/kgf·mm/cm/kgf) to display unit */
function toDisplay(value: number, category: keyof typeof CONVERSIONS, unit: string): number {
  const factor = (CONVERSIONS[category] as Record<string, number>)[unit] ?? 1;
  return Math.round(value * factor * 1000) / 1000;
}

/** Convert from display unit back to stored (bar/kgf·mm/cm/kgf) */
function fromDisplay(value: number, category: keyof typeof CONVERSIONS, unit: string): number {
  const factor = (CONVERSIONS[category] as Record<string, number>)[unit] ?? 1;
  return Math.round((value / factor) * 1000) / 1000;
}

function UnitToggle({ options, value, onChange }: { options: [string, string]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-0.5 ml-auto">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded transition-colors ${
            value === opt ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultTuneSettings(): TuneSettings {
  return {
    tires: { frontPressure: 1.7, rearPressure: 1.7 },
    gearing: { finalDrive: 3.5 },
    alignment: { frontCamber: -1.0, rearCamber: -0.5, frontToe: 0.0, rearToe: 0.0 },
    antiRollBars: { front: 20, rear: 20 },
    springs: { frontRate: 100, rearRate: 100, frontHeight: 10, rearHeight: 10 },
    damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
    aero: { frontDownforce: 100, rearDownforce: 100 },
    differential: { rearAccel: 60, rearDecel: 30 },
    brakes: { balance: 50, pressure: 100 },
  };
}

// ── Number field ─────────────────────────────────────────────────────────────

function NumberField({
  label,
  value,
  onChange,
  step,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-app-text-muted whitespace-nowrap">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          step={step ?? 0.1}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 bg-app-bg/85 border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
        />
        {unit && <span className="text-[10px] text-app-text-muted w-8">{unit}</span>}
      </div>
    </label>
  );
}

// ── Settings section ─────────────────────────────────────────────────────────

function SettingsSection({
  title,
  isOpen,
  onToggle,
  children,
  extra,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg ring-1 ring-app-border overflow-hidden">
      <div className="flex items-center bg-app-surface/85 hover:bg-app-surface transition-colors">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 text-left px-3 py-2 flex items-center justify-between"
        >
          <span className="text-xs font-semibold uppercase tracking-wider text-app-accent">
            {title}
          </span>
          <svg
            className={`w-3 h-3 text-app-text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {extra && <div className="flex items-center gap-1 pr-2">{extra}</div>}
      </div>
      {isOpen && <div className="p-3 space-y-1">{children}</div>}
    </div>
  );
}

// ── Settings display (read-only) ────────────────────────────────────────────

function TuneSettingsPanel({ settings }: { settings: TuneSettings }) {
  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: "Tires",
      rows: [
        ["Front Pressure", `${settings.tires.frontPressure.toFixed(2)} bar`],
        ["Rear Pressure", `${settings.tires.rearPressure.toFixed(2)} bar`],
      ],
    },
    {
      title: "Gearing",
      rows: [["Final Drive", settings.gearing.finalDrive.toFixed(2)]],
    },
    {
      title: "Alignment",
      rows: [
        ["Front Camber", `${settings.alignment.frontCamber.toFixed(1)}\u00B0`],
        ["Rear Camber", `${settings.alignment.rearCamber.toFixed(1)}\u00B0`],
        ["Front Toe", `${settings.alignment.frontToe.toFixed(1)}\u00B0`],
        ["Rear Toe", `${settings.alignment.rearToe.toFixed(1)}\u00B0`],
      ],
    },
    {
      title: "Springs",
      rows: [
        ["Front Rate", `${settings.springs.frontRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`],
        ["Rear Rate", `${settings.springs.rearRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`],
      ],
    },
    {
      title: "Aero",
      rows: [
        ["Front", `${settings.aero.frontDownforce} ${settings.aero.unit ?? "kgf"}`],
        ["Rear", `${settings.aero.rearDownforce} ${settings.aero.unit ?? "kgf"}`],
      ],
    },
    {
      title: "Differential",
      rows: [
        ["Rear Accel", `${settings.differential.rearAccel}%`],
        ["Rear Decel", `${settings.differential.rearDecel}%`],
      ],
    },
    {
      title: "Brakes",
      rows: [
        ["Balance", `${settings.brakes.balance}%`],
        ["Pressure", `${settings.brakes.pressure}%`],
      ],
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-w-2xl">
      {sections.map((section) => (
        <div key={section.title} className="rounded-lg bg-app-bg/85 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">
            {section.title}
          </h4>
          <div className="space-y-0">
            {section.rows.map(([label, value]) => (
              <div key={label} className="flex justify-between text-xs gap-2">
                <span className="text-app-text-muted whitespace-nowrap">{label}</span>
                <span className="text-app-text font-mono whitespace-nowrap">{value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tune Form Dialog ────────────────────────────────────────────────────────

interface TuneFormData {
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  description: string;
  settings: TuneSettings;
}

function TuneFormDialog({
  isOpen,
  onClose,
  initialData,
  onSubmit,
  title,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  initialData?: Partial<TuneFormData>;
  onSubmit: (data: TuneFormData) => void;
  title: string;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [author, setAuthor] = useState(initialData?.author ?? "Me");
  const [carOrdinal, setCarOrdinal] = useState(initialData?.carOrdinal ?? 2860);
  const [category, setCategory] = useState<TuneCategory>(initialData?.category ?? "circuit");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [settings, setSettings] = useState<TuneSettings>(initialData?.settings ?? defaultTuneSettings());
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [units, setUnits] = useState<UnitSystem>({ ...DEFAULT_UNITS });
  const [carSearchQuery, setCarSearchQuery] = useState("");
  const [carDropOpen, setCarDropOpen] = useState(false);
  const { data: allCars = [] } = useAllCars();

  const filteredFormCars = carSearchQuery
    ? allCars.filter((c) => c.name.toLowerCase().includes(carSearchQuery.toLowerCase())).slice(0, 20)
    : allCars.slice(0, 20);

  const selectedCarName = allCars.find((c) => c.ordinal === carOrdinal)?.name ?? (carOrdinal ? `Car #${carOrdinal}` : "Select car...");

  const toggleSection = (s: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const updateSettings = <K extends keyof TuneSettings>(group: K, field: string, value: number) => {
    setSettings((prev) => ({ ...prev, [group]: { ...prev[group], [field]: value } }));
  };

  const handleJsonParse = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const s = parsed.settings ?? parsed;
      const required = ["tires", "gearing", "alignment", "antiRollBars", "springs", "damping", "aero", "differential", "brakes"];
      for (const key of required) {
        if (!s[key]) throw new Error(`Missing section: ${key}`);
      }
      setSettings(s);
      if (parsed.name) setName(parsed.name);
      if (parsed.author) setAuthor(parsed.author);
      if (parsed.category) setCategory(parsed.category);
      if (parsed.description) setDescription(parsed.description);
      setJsonError("");
      setJsonMode(false);
    } catch (err: any) {
      setJsonError(err.message ?? "Invalid JSON");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, author, carOrdinal, category, description, settings });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-app-surface rounded-xl ring-1 ring-app-border shadow-2xl w-full max-w-lg max-h-[calc(100vh-4rem)] overflow-auto mx-4">
        <form onSubmit={handleSubmit}>
          <div className="sticky top-0 bg-app-surface px-4 py-3 border-b border-app-border flex items-center justify-between z-10">
            <h2 className="text-sm font-bold text-app-text">{title}</h2>
            <button type="button" onClick={onClose} className="text-app-text-muted hover:text-app-text text-lg leading-none">&times;</button>
          </div>

          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 space-y-1">
                <span className="text-xs font-medium text-app-text-muted">Name</span>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent" />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-app-text-muted">Author</span>
                <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} required className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent" />
              </label>
              <div className="space-y-1 relative">
                <span className="text-xs font-medium text-app-text-muted">Car</span>
                <input
                  type="text"
                  value={carDropOpen ? carSearchQuery : selectedCarName}
                  onChange={(e) => { setCarSearchQuery(e.target.value); setCarDropOpen(true); }}
                  onFocus={() => { setCarDropOpen(true); setCarSearchQuery(""); }}
                  onBlur={() => setTimeout(() => setCarDropOpen(false), 150)}
                  placeholder="Search car..."
                  className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                />
                {carDropOpen && (
                  <div className="absolute left-0 right-0 mt-1 max-h-48 overflow-auto rounded-lg bg-app-surface border border-app-border z-50 shadow-lg">
                    {filteredFormCars.map((c) => (
                      <button
                        key={c.ordinal}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setCarOrdinal(c.ordinal); setCarSearchQuery(""); setCarDropOpen(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${carOrdinal === c.ordinal ? "text-app-accent" : "text-app-text"}`}
                      >
                        {c.name}
                      </button>
                    ))}
                    {filteredFormCars.length === 0 && <div className="px-3 py-2 text-xs text-app-text-muted">No cars found</div>}
                  </div>
                )}
              </div>
              <label className="space-y-1">
                <span className="text-xs font-medium text-app-text-muted">Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value as TuneCategory)} className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent">
                  {ALL_CATEGORIES.map((c) => (<option key={c} value={c}>{CATEGORY_LABELS[c]}</option>))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-app-text-muted">Description</span>
                <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent" />
              </label>
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setJsonMode(!jsonMode)} className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${jsonMode ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}>
                JSON Import
              </button>
              {!jsonMode && <span className="text-[10px] text-app-text-muted">Or fill in sections below</span>}
            </div>

            {jsonMode ? (
              <div className="space-y-2">
                <textarea value={jsonText} onChange={(e) => { setJsonText(e.target.value); setJsonError(""); }} placeholder='Paste tune JSON...' rows={10} className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-xs text-app-text font-mono focus:outline-none focus:ring-1 focus:ring-app-accent resize-y" />
                {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}
                <button type="button" onClick={handleJsonParse} className="text-xs px-3 py-1.5 rounded bg-app-accent/20 text-app-accent hover:bg-app-accent/30 transition-colors">Parse & Populate</button>
              </div>
            ) : (
              <div className="space-y-2">
                <SettingsSection title="Tires" isOpen={openSections.has("tires")} onToggle={() => toggleSection("tires")}
                  extra={<UnitToggle options={["bar", "psi"]} value={units.tires} onChange={(v) => setUnits((u) => ({ ...u, tires: v as any }))} />}
                >
                  <NumberField label="Front Pressure" value={toDisplay(settings.tires.frontPressure, "tires", units.tires)} onChange={(v) => updateSettings("tires", "frontPressure", fromDisplay(v, "tires", units.tires))} step={units.tires === "psi" ? 0.1 : 0.01} unit={units.tires} />
                  <NumberField label="Rear Pressure" value={toDisplay(settings.tires.rearPressure, "tires", units.tires)} onChange={(v) => updateSettings("tires", "rearPressure", fromDisplay(v, "tires", units.tires))} step={units.tires === "psi" ? 0.1 : 0.01} unit={units.tires} />
                </SettingsSection>
                <SettingsSection title="Gearing" isOpen={openSections.has("gearing")} onToggle={() => toggleSection("gearing")}>
                  <NumberField label="Final Drive" value={settings.gearing.finalDrive} onChange={(v) => updateSettings("gearing", "finalDrive", v)} step={0.01} unit=":1" />
                </SettingsSection>
                <SettingsSection title="Alignment" isOpen={openSections.has("alignment")} onToggle={() => toggleSection("alignment")}>
                  <NumberField label="Front Camber" value={settings.alignment.frontCamber} onChange={(v) => updateSettings("alignment", "frontCamber", v)} unit="°" />
                  <NumberField label="Rear Camber" value={settings.alignment.rearCamber} onChange={(v) => updateSettings("alignment", "rearCamber", v)} unit="°" />
                  <NumberField label="Front Toe" value={settings.alignment.frontToe} onChange={(v) => updateSettings("alignment", "frontToe", v)} unit="°" />
                  <NumberField label="Rear Toe" value={settings.alignment.rearToe} onChange={(v) => updateSettings("alignment", "rearToe", v)} unit="°" />
                  <NumberField label="Front Caster" value={settings.alignment.frontCaster ?? 5.0} onChange={(v) => updateSettings("alignment", "frontCaster", v)} unit="°" />
                </SettingsSection>
                <SettingsSection title="Anti-Roll Bars" isOpen={openSections.has("arb")} onToggle={() => toggleSection("arb")}>
                  <NumberField label="Front" value={settings.antiRollBars.front} onChange={(v) => updateSettings("antiRollBars", "front", v)} />
                  <NumberField label="Rear" value={settings.antiRollBars.rear} onChange={(v) => updateSettings("antiRollBars", "rear", v)} />
                </SettingsSection>
                <SettingsSection title="Springs" isOpen={openSections.has("springs")} onToggle={() => toggleSection("springs")}
                  extra={<>
                    <UnitToggle options={["kgf/mm", "lb/in"]} value={units.springs} onChange={(v) => setUnits((u) => ({ ...u, springs: v as any }))} />
                    <UnitToggle options={["cm", "in"]} value={units.height} onChange={(v) => setUnits((u) => ({ ...u, height: v as any }))} />
                  </>}
                >
                  <NumberField label="Front Rate" value={toDisplay(settings.springs.frontRate, "springs", units.springs)} onChange={(v) => updateSettings("springs", "frontRate", fromDisplay(v, "springs", units.springs))} step={units.springs === "lb/in" ? 1 : 0.1} unit={units.springs} />
                  <NumberField label="Rear Rate" value={toDisplay(settings.springs.rearRate, "springs", units.springs)} onChange={(v) => updateSettings("springs", "rearRate", fromDisplay(v, "springs", units.springs))} step={units.springs === "lb/in" ? 1 : 0.1} unit={units.springs} />
                  <NumberField label="Front Height" value={toDisplay(settings.springs.frontHeight, "height", units.height)} onChange={(v) => updateSettings("springs", "frontHeight", fromDisplay(v, "height", units.height))} step={0.1} unit={units.height} />
                  <NumberField label="Rear Height" value={toDisplay(settings.springs.rearHeight, "height", units.height)} onChange={(v) => updateSettings("springs", "rearHeight", fromDisplay(v, "height", units.height))} step={0.1} unit={units.height} />
                </SettingsSection>
                <SettingsSection title="Damping" isOpen={openSections.has("damping")} onToggle={() => toggleSection("damping")}>
                  <NumberField label="Front Rebound" value={settings.damping.frontRebound} onChange={(v) => updateSettings("damping", "frontRebound", v)} />
                  <NumberField label="Rear Rebound" value={settings.damping.rearRebound} onChange={(v) => updateSettings("damping", "rearRebound", v)} />
                  <NumberField label="Front Bump" value={settings.damping.frontBump} onChange={(v) => updateSettings("damping", "frontBump", v)} />
                  <NumberField label="Rear Bump" value={settings.damping.rearBump} onChange={(v) => updateSettings("damping", "rearBump", v)} />
                </SettingsSection>
                <SettingsSection title="Aero" isOpen={openSections.has("aero")} onToggle={() => toggleSection("aero")}
                  extra={<UnitToggle options={["kgf", "lb"]} value={units.aero} onChange={(v) => setUnits((u) => ({ ...u, aero: v as any }))} />}
                >
                  <NumberField label="Front Downforce" value={toDisplay(settings.aero.frontDownforce, "aero", units.aero)} onChange={(v) => updateSettings("aero", "frontDownforce", fromDisplay(v, "aero", units.aero))} step={1} unit={units.aero} />
                  <NumberField label="Rear Downforce" value={toDisplay(settings.aero.rearDownforce, "aero", units.aero)} onChange={(v) => updateSettings("aero", "rearDownforce", fromDisplay(v, "aero", units.aero))} step={1} unit={units.aero} />
                </SettingsSection>
                <SettingsSection title="Differential" isOpen={openSections.has("diff")} onToggle={() => toggleSection("diff")}>
                  <NumberField label="Rear Accel" value={settings.differential.rearAccel} onChange={(v) => updateSettings("differential", "rearAccel", v)} step={1} unit="%" />
                  <NumberField label="Rear Decel" value={settings.differential.rearDecel} onChange={(v) => updateSettings("differential", "rearDecel", v)} step={1} unit="%" />
                  <NumberField label="Front Accel" value={settings.differential.frontAccel ?? 0} onChange={(v) => updateSettings("differential", "frontAccel", v)} step={1} unit="%" />
                  <NumberField label="Front Decel" value={settings.differential.frontDecel ?? 0} onChange={(v) => updateSettings("differential", "frontDecel", v)} step={1} unit="%" />
                </SettingsSection>
                <SettingsSection title="Brakes" isOpen={openSections.has("brakes")} onToggle={() => toggleSection("brakes")}>
                  <NumberField label="Balance" value={settings.brakes.balance} onChange={(v) => updateSettings("brakes", "balance", v)} step={1} unit="%" />
                  <NumberField label="Pressure" value={settings.brakes.pressure} onChange={(v) => updateSettings("brakes", "pressure", v)} step={1} unit="%" />
                </SettingsSection>
              </div>
            )}
          </div>

          <div className="sticky bottom-0 bg-app-surface px-4 py-3 border-t border-app-border flex justify-end gap-2">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-app-border text-app-text-secondary hover:text-app-text transition-colors">Cancel</button>
            <button type="submit" disabled={!name || isSubmitting} className="text-xs px-3 py-1.5 rounded bg-app-accent text-white hover:bg-app-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {isSubmitting ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── User Tune Card ──────────────────────────────────────────────────────────

function UserTuneCard({
  tune,
  isExpanded,
  onToggle,
  onEdit,
  onDelete,
  isDeleting,
}: {
  tune: Tune;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="rounded-xl bg-app-surface/85 ring-1 ring-app-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-app-text">{tune.name}</span>
            <span className="text-[10px] font-mono text-app-text-muted">
              Car {tune.carOrdinal}
            </span>
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${CATEGORY_COLORS[tune.category] ?? "bg-gray-500/20 text-gray-400"}`}>
              {CATEGORY_LABELS[tune.category] ?? tune.category}
            </span>
            {tune.source === "catalog-clone" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">Cloned</span>
            )}
          </div>
          <p className={`text-xs text-app-text-muted mt-0.5 ${isExpanded ? "" : "line-clamp-1"}`}>
            {tune.description}
          </p>
        </div>
        <svg className={`w-4 h-4 text-app-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-app-border">
          <div className="flex items-center gap-2 pt-3">
            <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors">Edit</button>
            {!confirmDelete ? (
              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }} className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors">Delete</button>
            ) : (
              <span className="flex items-center gap-1">
                <span className="text-[10px] text-red-400">Sure?</span>
                <button onClick={(e) => { e.stopPropagation(); onDelete(); }} disabled={isDeleting} className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-red-600/30 text-red-300 hover:bg-red-600/50 disabled:opacity-50 transition-colors">{isDeleting ? "..." : "Yes"}</button>
                <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }} className="text-[10px] font-semibold uppercase px-2 py-1 rounded text-app-text-muted hover:text-app-text transition-colors">No</button>
              </span>
            )}
          </div>
          {tune.settings && <TuneSettingsPanel settings={tune.settings} />}
          <div className="text-[10px] text-app-text-muted pt-1">
            by {tune.author} &middot; {tune.source === "catalog-clone" ? "cloned from catalog" : "user created"}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Manage Page ─────────────────────────────────────────────────────────

function ManageTunesPage() {
  const [expandedTune, setExpandedTune] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingTune, setEditingTune] = useState<Tune | null>(null);
  const [selectedCar, setSelectedCar] = useState<number | null>(null);
  const [carSearch, setCarSearch] = useState("");
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);

  const { data: userTunes = [], isLoading } = useUserTunes();
  const { data: assignments = [] } = useTuneAssignments();
  const createTune = useCreateTune();
  const updateTune = useUpdateTune();
  const deleteTuneMut = useDeleteTune();
  const deleteAssignment = useDeleteTuneAssignment();

  const filteredCars = carSearch
    ? CATALOG_CARS.filter((c) => c.name.toLowerCase().includes(carSearch.toLowerCase()))
    : CATALOG_CARS;

  const filteredUserTunes = useMemo(() => {
    return userTunes.filter((t) => {
      if (selectedCar != null && t.carOrdinal !== selectedCar) return false;
      return true;
    });
  }, [userTunes, selectedCar]);

  const filteredAssignments = assignments.filter(
    (a) => selectedCar == null || a.carOrdinal === selectedCar,
  );

  const handleCreateSubmit = (data: TuneFormData) => {
    createTune.mutate(data as any, { onSuccess: () => setFormOpen(false) });
  };

  const handleEditSubmit = (data: TuneFormData) => {
    if (!editingTune) return;
    updateTune.mutate({ id: editingTune.id, ...data } as any, {
      onSuccess: () => { setEditingTune(null); setFormOpen(false); },
    });
  };

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link to="/tunes" className="text-app-text-muted hover:text-app-text text-sm no-underline">&larr;</Link>
            <h1 className="text-lg font-bold text-app-text">My Tunes</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
              {filteredUserTunes.length}
            </span>
          </div>
          <p className="text-xs text-app-text-muted">
            Manage your saved tunes and track assignments
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => { setEditingTune(null); setFormOpen(true); }}
            className="text-xs px-3 py-1.5 rounded bg-app-accent text-white hover:bg-app-accent/80 transition-colors"
          >
            + New Tune
          </button>
          <div className="relative">
            <input
              type="text"
              value={carDropdownOpen ? carSearch : selectedCar != null ? (getCatalogCar(selectedCar)?.name ?? `Car ${selectedCar}`) : ""}
              onChange={(e) => { setCarSearch(e.target.value); setCarDropdownOpen(true); }}
              onFocus={() => { setCarDropdownOpen(true); setCarSearch(""); }}
              onBlur={() => setTimeout(() => setCarDropdownOpen(false), 150)}
              placeholder="Filter by car..."
              className="bg-app-surface text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border focus:outline-none focus:ring-1 focus:ring-app-accent w-48"
            />
            {carDropdownOpen && (
              <div className="absolute right-0 mt-1 w-56 max-h-60 overflow-auto rounded-lg bg-app-surface border border-app-border z-50 shadow-lg">
                {!carSearch && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setSelectedCar(null); setCarSearch(""); setCarDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${selectedCar == null ? "text-app-accent" : "text-app-text"}`}
                  >
                    All Cars
                  </button>
                )}
                {filteredCars.map((c) => (
                  <button
                    key={c.ordinal}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setSelectedCar(c.ordinal); setCarSearch(""); setCarDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${selectedCar === c.ordinal ? "text-app-accent" : "text-app-text"}`}
                  >
                    {c.name}
                  </button>
                ))}
                {filteredCars.length === 0 && <div className="px-3 py-2 text-xs text-app-text-muted">No cars found</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tune list */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="text-center py-12 text-app-text-muted text-sm">Loading tunes...</div>
        ) : filteredUserTunes.length === 0 ? (
          <div className="text-center py-12 text-app-text-muted text-sm">
            <p>No user tunes yet.</p>
            <p className="mt-1">Create a new tune or <Link to="/tunes" className="text-app-accent hover:underline">clone one from the catalog</Link>.</p>
          </div>
        ) : (
          filteredUserTunes.map((tune) => (
            <UserTuneCard
              key={tune.id}
              tune={tune}
              isExpanded={expandedTune === `user-${tune.id}`}
              onToggle={() => setExpandedTune(expandedTune === `user-${tune.id}` ? null : `user-${tune.id}`)}
              onEdit={() => { setEditingTune(tune); setFormOpen(true); }}
              onDelete={() => deleteTuneMut.mutate(tune.id)}
              isDeleting={deleteTuneMut.isPending}
            />
          ))
        )}
      </div>

      {/* Tune Assignments */}
      {filteredAssignments.length > 0 && (
        <div className="pt-4 border-t border-app-border">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted mb-2">
            Active Tune Assignments
          </h3>
          <div className="space-y-1">
            {filteredAssignments.map((a) => (
              <div key={`${a.carOrdinal}-${a.trackOrdinal}`} className="flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-app-bg/85">
                <span className="text-app-text-secondary">Car {a.carOrdinal} / Track {a.trackOrdinal}</span>
                <div className="flex items-center gap-2">
                  <span className="text-app-text font-medium">{a.tuneName ?? `Tune #${a.tuneId}`}</span>
                  <button
                    onClick={() => deleteAssignment.mutate({ carOrdinal: a.carOrdinal, trackOrdinal: a.trackOrdinal })}
                    className="text-red-400 hover:text-red-300 transition-colors"
                    title="Remove assignment"
                  >
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <TuneFormDialog
        isOpen={formOpen}
        onClose={() => { setFormOpen(false); setEditingTune(null); }}
        initialData={editingTune ? {
          name: editingTune.name,
          author: editingTune.author,
          carOrdinal: editingTune.carOrdinal,
          category: editingTune.category,
          description: editingTune.description,
          settings: editingTune.settings,
        } : selectedCar != null ? { carOrdinal: selectedCar } : undefined}
        onSubmit={editingTune ? handleEditSubmit : handleCreateSubmit}
        title={editingTune ? `Edit: ${editingTune.name}` : "Create New Tune"}
        isSubmitting={createTune.isPending || updateTune.isPending}
      />
    </div>
  );
}

export const Route = createFileRoute("/tunes/manage")({
  component: ManageTunesPage,
});
