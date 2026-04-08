import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { useQuery } from "@tanstack/react-query";
import type { TuneSettings } from "../data/tune-catalog";
import type { TuneCategory } from "@shared/types";
import { client } from "../lib/rpc";

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAllCars() {
  return useQuery<{ ordinal: number; name: string; specs?: { topSpeedMph: number } }[]>({
    queryKey: ["all-cars"],
    queryFn: () => client.api.cars.$get().then((r) => r.json()),
    staleTime: Infinity,
  });
}

// ── Constants ────────────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
  circuit: "Circuit",
  wet: "Wet",
  "low-drag": "Low Drag",
  stable: "Stable",
  "track-specific": "Track Specific",
};

export const CATEGORY_COLORS: Record<string, string> = {
  circuit: "bg-blue-500/20 text-blue-400",
  wet: "bg-cyan-500/20 text-cyan-400",
  "low-drag": "bg-red-500/20 text-red-400",
  stable: "bg-green-500/20 text-green-400",
  "track-specific": "bg-orange-500/20 text-orange-400",
};

export const ALL_CATEGORIES: TuneCategory[] = [
  "circuit",
  "wet",
  "low-drag",
  "stable",
  "track-specific",
];

// ── Unit conversion ──────────────────────────────────────────────────────────

const IMPERIAL = {
  tires:   { factor: 14.50377, metric: "bar",    imperial: "psi" },
  springs: { factor: 56.0,     metric: "kgf/mm", imperial: "lb/in" },
  height:  { factor: 0.393701, metric: "cm",     imperial: "in" },
  aero:    { factor: 2.20462,  metric: "kgf",    imperial: "lb" },
} as const;

type ConvCategory = keyof typeof IMPERIAL;

export function toDisplay(value: number, cat: ConvCategory, isMetric: boolean): number {
  if (isMetric) return value;
  return Math.round(value * IMPERIAL[cat].factor * 1000) / 1000;
}

export function fromDisplay(value: number, cat: ConvCategory, isMetric: boolean): number {
  if (isMetric) return value;
  return Math.round((value / IMPERIAL[cat].factor) * 1000) / 1000;
}

export function unitLabel(cat: ConvCategory, isMetric: boolean): string {
  return isMetric ? IMPERIAL[cat].metric : IMPERIAL[cat].imperial;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function defaultTuneSettings(): TuneSettings {
  return {
    tires: { frontPressure: 1.7, rearPressure: 1.7 },
    gearing: { finalDrive: 3.5 },
    alignment: { frontCamber: -1.0, rearCamber: -0.5, frontToe: 0.0, rearToe: 0.0 },
    antiRollBars: { front: 20, rear: 20 },
    springs: { frontRate: 100, rearRate: 100, frontHeight: 10, rearHeight: 10 },
    damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
    rollCenterHeight: { front: 0, rear: 0 },
    antiGeometry: { antiDiveFront: 0, antiSquatRear: 0 },
    aero: { frontDownforce: 100, rearDownforce: 100 },
    differential: { rearAccel: 60, rearDecel: 30 },
    brakes: { balance: 50, pressure: 100 },
  };
}

export function withDefaults(s?: TuneSettings): TuneSettings {
  if (!s) return defaultTuneSettings();
  return {
    ...s,
    rollCenterHeight: s.rollCenterHeight ?? { front: 0, rear: 0 },
    antiGeometry: s.antiGeometry ?? { antiDiveFront: 0, antiSquatRear: 0 },
  };
}

// ── TuneFormData interface ───────────────────────────────────────────────────

export interface TuneFormData {
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  description: string;
  settings: TuneSettings;
  unitSystem: "metric" | "imperial";
}

// ── NumberField ──────────────────────────────────────────────────────────────

export function NumberField({
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
          className="w-20 bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
        />
        {unit && <span className="text-[10px] text-app-text-muted w-8">{unit}</span>}
      </div>
    </label>
  );
}


// ── TuneSettingsPanel (read-only) ────────────────────────────────────────────

export function TuneSettingsPanel({ settings: raw }: { settings: TuneSettings }) {
  const settings = {
    ...raw,
    rollCenterHeight: raw.rollCenterHeight ?? { front: 0, rear: 0 },
    antiGeometry: raw.antiGeometry ?? { antiDiveFront: 0, antiSquatRear: 0 },
  };
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
      title: "Anti-Roll Bars",
      rows: [
        ["Front", settings.antiRollBars.front.toFixed(1)],
        ["Rear", settings.antiRollBars.rear.toFixed(1)],
      ],
    },
    {
      title: "Springs",
      rows: [
        ["Front Rate", `${settings.springs.frontRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`],
        ["Rear Rate", `${settings.springs.rearRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`],
        ["Front Height", `${settings.springs.frontHeight.toFixed(1)} cm`],
        ["Rear Height", `${settings.springs.rearHeight.toFixed(1)} cm`],
      ],
    },
    {
      title: "Damping",
      rows: [
        ["Front Rebound", settings.damping.frontRebound.toFixed(1)],
        ["Rear Rebound", settings.damping.rearRebound.toFixed(1)],
        ["Front Bump", settings.damping.frontBump.toFixed(1)],
        ["Rear Bump", settings.damping.rearBump.toFixed(1)],
      ],
    },
    {
      title: "Roll Center Height",
      rows: [
        ["Front", `${settings.rollCenterHeight.front.toFixed(1)} cm`],
        ["Rear", `${settings.rollCenterHeight.rear.toFixed(1)} cm`],
      ],
    },
    {
      title: "Anti-Geometry",
      rows: [
        ["Anti-dive (front)", `${settings.antiGeometry.antiDiveFront.toFixed(1)}%`],
        ["Anti-squat (rear)", `${settings.antiGeometry.antiSquatRear.toFixed(1)}%`],
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
        ...(settings.differential.frontAccel != null ? [["Front Accel", `${settings.differential.frontAccel}%`] as [string, string]] : []),
        ...(settings.differential.frontDecel != null ? [["Front Decel", `${settings.differential.frontDecel}%`] as [string, string]] : []),
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
        <div key={section.title} className="rounded-lg bg-app-bg p-3">
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

// ── UserTuneCard ─────────────────────────────────────────────────────────────

export function UserTuneCard({
  tune,
  carName,
  isExpanded,
  onToggle,
  onEdit,
  onDelete,
  isDeleting,
}: {
  tune: { id: number; name: string; carOrdinal: number; category: string; source?: string; description: string; author: string; settings?: TuneSettings };
  carName?: string;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="rounded-xl bg-app-surface ring-1 ring-app-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-app-text">{tune.name}</span>
            <span className="text-[10px] font-mono text-app-text-muted">
              {carName ?? `Car #${tune.carOrdinal}`}
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

// ── GearRatioChart ────────────────────────────────────────────────────────────

function GearRatioChart({ ratios, finalDrive, topSpeedMph }: { ratios: number[]; finalDrive: number; topSpeedMph?: number }) {
  if (!ratios.length) return null;

  const MAX_RPM = 8000;
  const topGearRatio = ratios[ratios.length - 1];
  // Back-calculate tire circumference from stock top speed if available, else use typical 2.0m
  const CIRC = topSpeedMph && topGearRatio
    ? (topSpeedMph * 1.60934 * topGearRatio * finalDrive) / (MAX_RPM / 60) / 3.6
    : 2.0;
  const toKph = (rpm: number, ratio: number) =>
    (rpm / 60 / (ratio * finalDrive)) * CIRC * 3.6;

  const maxSpeed = Math.ceil(toKph(MAX_RPM, ratios[ratios.length - 1]) / 50) * 50;

  const W = 340, H = 160;
  const pad = { top: 20, right: 20, bottom: 28, left: 32 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const sx = (v: number) => Math.min((v / maxSpeed) * cW, cW);
  const sy = (rpm: number) => cH - (rpm / MAX_RPM) * cH;

  const COLORS = ['#f87171','#fb923c','#facc15','#4ade80','#60a5fa','#a78bfa','#f472b6','#34d399','#38bdf8','#f59e0b'];
  const rpmGrids = [2000, 4000, 6000, 8000];
  const speedGrids = Array.from({ length: 6 }, (_, i) => Math.round((maxSpeed / 5) * i));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <defs>
        <clipPath id="gchart">
          <rect x={pad.left} y={pad.top} width={cW} height={cH} />
        </clipPath>
      </defs>

      {/* RPM gridlines */}
      {rpmGrids.map(rpm => (
        <g key={rpm}>
          <line x1={pad.left} y1={pad.top + sy(rpm)} x2={pad.left + cW} y2={pad.top + sy(rpm)}
            stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
          <text x={pad.left - 3} y={pad.top + sy(rpm) + 3} textAnchor="end" fontSize="7"
            fill="currentColor" fillOpacity="0.4">{rpm / 1000}k</text>
        </g>
      ))}

      {/* Speed gridlines */}
      {speedGrids.map(spd => (
        <g key={spd}>
          <line x1={pad.left + sx(spd)} y1={pad.top} x2={pad.left + sx(spd)} y2={pad.top + cH}
            stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
          <text x={pad.left + sx(spd)} y={pad.top + cH + 10} textAnchor="middle" fontSize="7"
            fill="currentColor" fillOpacity="0.4">{spd}</text>
        </g>
      ))}

      {/* Axis labels */}
      <text x={pad.left + cW / 2} y={H - 2} textAnchor="middle" fontSize="7"
        fill="currentColor" fillOpacity="0.4">km/h</text>
      <text x={8} y={pad.top + cH / 2} textAnchor="middle" fontSize="7"
        fill="currentColor" fillOpacity="0.4" transform={`rotate(-90 8 ${pad.top + cH / 2})`}>RPM</text>

      {/* Gear lines */}
      {ratios.map((ratio, i) => {
        const pts = Array.from({ length: 60 }, (_, j) => {
          const rpm = (j / 59) * MAX_RPM;
          return `${pad.left + sx(toKph(rpm, ratio))},${pad.top + sy(rpm)}`;
        }).join(' ');
        const labelX = pad.left + sx(toKph(MAX_RPM, ratio));
        const color = COLORS[i % COLORS.length];
        return (
          <g key={i}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
              strokeOpacity="0.85" clipPath="url(#gchart)" />
            <text x={labelX} y={pad.top - 5} textAnchor="middle" fontSize="8"
              fill={color} fillOpacity="0.9" fontWeight="600">{i + 1}</text>
          </g>
        );
      })}

      {/* Chart border */}
      <rect x={pad.left} y={pad.top} width={cW} height={cH}
        fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
    </svg>
  );
}

// ── TuneForm (tabbed full-page) ───────────────────────────────────────────────

export function TuneForm({
  initialData,
  onSubmit,
  onCancel,
  title,
  isSubmitting,
}: {
  initialData?: Partial<TuneFormData>;
  onSubmit: (data: TuneFormData) => void;
  onCancel: () => void;
  title: string;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [author, setAuthor] = useState(initialData?.author ?? "Me");
  const [carOrdinal, setCarOrdinal] = useState(initialData?.carOrdinal ?? 2860);
  const [category, setCategory] = useState<TuneCategory>(initialData?.category ?? "circuit");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [settings, setSettings] = useState<TuneSettings>(withDefaults(initialData?.settings));
  const [activeTab, setActiveTab] = useState<"info" | "settings">("info");
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [isMetric, setIsMetric] = useState(() => {
    const u = initialData?.settings?.springs?.unit;
    const au = initialData?.settings?.aero?.unit;
    return u !== "lb/in" && au !== "lb";
  });
  const [carSearchQuery, setCarSearchQuery] = useState("");
  const [carDropOpen, setCarDropOpen] = useState(false);
  const { data: allCars = [] } = useAllCars();

  const filteredFormCars = carSearchQuery
    ? allCars.filter((c) => c.name.toLowerCase().includes(carSearchQuery.toLowerCase())).slice(0, 20)
    : allCars.slice(0, 20);

  const selectedCarName = allCars.find((c) => c.ordinal === carOrdinal)?.name ?? (carOrdinal ? `Car #${carOrdinal}` : "Select car...");

  useEffect(() => {
    setName(initialData?.name ?? "");
    setAuthor(initialData?.author ?? "Me");
    setCarOrdinal(initialData?.carOrdinal ?? 2860);
    setCategory(initialData?.category ?? "circuit");
    setDescription(initialData?.description ?? "");
    setSettings(withDefaults(initialData?.settings));
    setActiveTab("info");
    setJsonMode(false);
    setJsonText("");
    setJsonError("");
    const u = initialData?.settings?.springs?.unit;
    const au = initialData?.settings?.aero?.unit;
    setIsMetric(u !== "lb/in" && au !== "lb");
  }, [initialData]);

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
      setSettings(withDefaults(s));
      if (parsed.name) setName(parsed.name);
      if (parsed.author) setAuthor(parsed.author);
      if (parsed.category) setCategory(parsed.category);
      if (parsed.description) setDescription(parsed.description);
      setJsonError("");
      setJsonMode(false);
    } catch (err: unknown) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const savedSettings: TuneSettings = {
      ...settings,
      springs: { ...settings.springs, unit: unitLabel("springs", isMetric) },
      aero: { ...settings.aero, unit: unitLabel("aero", isMetric) },
    };
    onSubmit({ name, author, carOrdinal, category, description, settings: savedSettings, unitSystem: isMetric ? "metric" : "imperial" });
  };

  const tabCls = (tab: "info" | "settings") =>
    `px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
      activeTab === tab
        ? "border-app-accent text-app-accent"
        : "border-transparent text-app-text-muted hover:text-app-text"
    }`;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col min-h-full">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-app-bg border-b border-app-border flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="app-ghost" size="app-sm" onClick={onCancel}>&larr;</Button>
          <h2 className="text-base font-bold text-app-text">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="app-outline" size="app-md" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="app-primary" size="app-md" disabled={!name || isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Tune"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-app-border px-6">
        <button type="button" className={tabCls("info")} onClick={() => setActiveTab("info")}>Info</button>
        <button type="button" className={tabCls("settings")} onClick={() => setActiveTab("settings")}>Settings</button>
      </div>

      {/* Info tab */}
      {activeTab === "info" && (
        <div className="p-6 grid grid-cols-2 gap-4 max-w-2xl">
          <label className="col-span-2 space-y-1">
            <span className="text-xs font-medium text-app-text-muted">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent" />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-app-text-muted">Author</span>
            <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} required className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent" />
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
              className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
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
            <select value={category} onChange={(e) => setCategory(e.target.value as TuneCategory)} className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent">
              {ALL_CATEGORIES.map((c) => (<option key={c} value={c}>{CATEGORY_LABELS[c]}</option>))}
            </select>
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-xs font-medium text-app-text-muted">Description</span>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent" />
          </label>
        </div>
      )}

      {/* Settings tab */}
      {activeTab === "settings" && (
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted">Tune Parameters</h3>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setJsonMode(!jsonMode)} className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${jsonMode ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}>
                JSON Import
              </button>
              {!jsonMode && (
                <div className="flex rounded-md ring-1 ring-app-border overflow-hidden">
                  <button type="button" onClick={() => setIsMetric(true)} className={`text-[10px] font-semibold px-2.5 py-1 transition-colors ${isMetric ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}>Metric</button>
                  <button type="button" onClick={() => setIsMetric(false)} className={`text-[10px] font-semibold px-2.5 py-1 transition-colors ${!isMetric ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}>Imperial</button>
                </div>
              )}
            </div>
          </div>

          {jsonMode ? (
            <div className="space-y-2">
              <textarea value={jsonText} onChange={(e) => { setJsonText(e.target.value); setJsonError(""); }} placeholder='Paste tune JSON...' rows={10} className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs text-app-text font-mono focus:outline-none focus:ring-1 focus:ring-app-accent resize-y" />
              {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}
              <button type="button" onClick={handleJsonParse} className="text-xs px-3 py-1.5 rounded bg-app-accent/20 text-app-accent hover:bg-app-accent/30 transition-colors">Parse & Populate</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Tires</h4>
                <NumberField label="Front Pressure" value={toDisplay(settings.tires.frontPressure, "tires", isMetric)} onChange={(v) => updateSettings("tires", "frontPressure", fromDisplay(v, "tires", isMetric))} step={isMetric ? 0.01 : 0.1} unit={unitLabel("tires", isMetric)} />
                <NumberField label="Rear Pressure" value={toDisplay(settings.tires.rearPressure, "tires", isMetric)} onChange={(v) => updateSettings("tires", "rearPressure", fromDisplay(v, "tires", isMetric))} step={isMetric ? 0.01 : 0.1} unit={unitLabel("tires", isMetric)} />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Gearing</h4>
                <NumberField label="Final Drive" value={settings.gearing.finalDrive} onChange={(v) => updateSettings("gearing", "finalDrive", v)} step={0.01} unit=":1" />
                <div className="space-y-1 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-app-text-muted">Gear Ratios</span>
                    <select
                      value={settings.gearing.ratios?.length ?? 6}
                      onChange={(e) => {
                        const count = parseInt(e.target.value);
                        const current = settings.gearing.ratios ?? [];
                        const ratios = Array.from({ length: count }, (_, i) => current[i] ?? (3.5 - i * 0.4));
                        setSettings((s) => ({ ...s, gearing: { ...s.gearing, ratios } }));
                      }}
                      className="bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text"
                    >
                      {[1,2,3,4,5,6,7,8,9,10].map((n) => (
                        <option key={n} value={n}>{n} gears</option>
                      ))}
                    </select>
                  </div>
                  {(settings.gearing.ratios ?? []).map((ratio, i) => (
                    <NumberField
                      key={i}
                      label={`Gear ${i + 1}`}
                      value={ratio}
                      onChange={(v) => {
                        const ratios = [...(settings.gearing.ratios ?? [])];
                        ratios[i] = v;
                        setSettings((s) => ({ ...s, gearing: { ...s.gearing, ratios } }));
                      }}
                      step={0.01}
                      unit=":1"
                    />
                  ))}
                  <GearRatioChart
                    ratios={settings.gearing.ratios ?? []}
                    finalDrive={settings.gearing.finalDrive}
                    topSpeedMph={allCars.find((c) => c.ordinal === carOrdinal)?.specs?.topSpeedMph}
                  />
                </div>
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Alignment</h4>
                <NumberField label="Front Camber" value={settings.alignment.frontCamber} onChange={(v) => updateSettings("alignment", "frontCamber", v)} unit="°" />
                <NumberField label="Rear Camber" value={settings.alignment.rearCamber} onChange={(v) => updateSettings("alignment", "rearCamber", v)} unit="°" />
                <NumberField label="Front Toe" value={settings.alignment.frontToe} onChange={(v) => updateSettings("alignment", "frontToe", v)} unit="°" />
                <NumberField label="Rear Toe" value={settings.alignment.rearToe} onChange={(v) => updateSettings("alignment", "rearToe", v)} unit="°" />
                <NumberField label="Front Caster" value={settings.alignment.frontCaster ?? 5.0} onChange={(v) => updateSettings("alignment", "frontCaster", v)} unit="°" />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">Anti-Roll Bars</h4>
                  <span className="text-[10px] text-app-text-muted">soft → stiff</span>
                </div>
                <NumberField label="Front" value={settings.antiRollBars.front} onChange={(v) => updateSettings("antiRollBars", "front", v)} />
                <NumberField label="Rear" value={settings.antiRollBars.rear} onChange={(v) => updateSettings("antiRollBars", "rear", v)} />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Springs</h4>
                <NumberField label="Front Rate" value={toDisplay(settings.springs.frontRate, "springs", isMetric)} onChange={(v) => updateSettings("springs", "frontRate", fromDisplay(v, "springs", isMetric))} step={isMetric ? 0.1 : 1} unit={unitLabel("springs", isMetric)} />
                <NumberField label="Rear Rate" value={toDisplay(settings.springs.rearRate, "springs", isMetric)} onChange={(v) => updateSettings("springs", "rearRate", fromDisplay(v, "springs", isMetric))} step={isMetric ? 0.1 : 1} unit={unitLabel("springs", isMetric)} />
                <NumberField label="Front Height" value={toDisplay(settings.springs.frontHeight, "height", isMetric)} onChange={(v) => updateSettings("springs", "frontHeight", fromDisplay(v, "height", isMetric))} step={0.1} unit={unitLabel("height", isMetric)} />
                <NumberField label="Rear Height" value={toDisplay(settings.springs.rearHeight, "height", isMetric)} onChange={(v) => updateSettings("springs", "rearHeight", fromDisplay(v, "height", isMetric))} step={0.1} unit={unitLabel("height", isMetric)} />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">Damping</h4>
                  <span className="text-[10px] text-app-text-muted">soft → stiff</span>
                </div>
                <NumberField label="Front Rebound" value={settings.damping.frontRebound} onChange={(v) => updateSettings("damping", "frontRebound", v)} />
                <NumberField label="Rear Rebound" value={settings.damping.rearRebound} onChange={(v) => updateSettings("damping", "rearRebound", v)} />
                <NumberField label="Front Bump" value={settings.damping.frontBump} onChange={(v) => updateSettings("damping", "frontBump", v)} />
                <NumberField label="Rear Bump" value={settings.damping.rearBump} onChange={(v) => updateSettings("damping", "rearBump", v)} />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Roll Center Height</h4>
                <NumberField label="Front" value={settings.rollCenterHeight.front} onChange={(v) => setSettings((s) => ({ ...s, rollCenterHeight: { ...s.rollCenterHeight, front: v } }))} unit="cm" />
                <NumberField label="Rear" value={settings.rollCenterHeight.rear} onChange={(v) => setSettings((s) => ({ ...s, rollCenterHeight: { ...s.rollCenterHeight, rear: v } }))} unit="cm" />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Anti-Geometry</h4>
                <NumberField label="Anti-dive (front)" value={settings.antiGeometry.antiDiveFront} onChange={(v) => setSettings((s) => ({ ...s, antiGeometry: { ...s.antiGeometry, antiDiveFront: v } }))} unit="%" />
                <NumberField label="Anti-squat (rear)" value={settings.antiGeometry.antiSquatRear} onChange={(v) => setSettings((s) => ({ ...s, antiGeometry: { ...s.antiGeometry, antiSquatRear: v } }))} unit="%" />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Aero</h4>
                <NumberField label="Front Downforce" value={toDisplay(settings.aero.frontDownforce, "aero", isMetric)} onChange={(v) => updateSettings("aero", "frontDownforce", fromDisplay(v, "aero", isMetric))} step={1} unit={unitLabel("aero", isMetric)} />
                <NumberField label="Rear Downforce" value={toDisplay(settings.aero.rearDownforce, "aero", isMetric)} onChange={(v) => updateSettings("aero", "rearDownforce", fromDisplay(v, "aero", isMetric))} step={1} unit={unitLabel("aero", isMetric)} />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Differential</h4>
                <NumberField label="Rear Accel" value={settings.differential.rearAccel} onChange={(v) => updateSettings("differential", "rearAccel", v)} step={1} unit="%" />
                <NumberField label="Rear Decel" value={settings.differential.rearDecel} onChange={(v) => updateSettings("differential", "rearDecel", v)} step={1} unit="%" />
                <NumberField label="Front Accel" value={settings.differential.frontAccel ?? 0} onChange={(v) => updateSettings("differential", "frontAccel", v)} step={1} unit="%" />
                <NumberField label="Front Decel" value={settings.differential.frontDecel ?? 0} onChange={(v) => updateSettings("differential", "frontDecel", v)} step={1} unit="%" />
              </div>

              <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">Brakes</h4>
                <NumberField label="Balance" value={settings.brakes.balance} onChange={(v) => updateSettings("brakes", "balance", v)} step={1} unit="%" />
                <NumberField label="Pressure" value={settings.brakes.pressure} onChange={(v) => updateSettings("brakes", "pressure", v)} step={1} unit="%" />
              </div>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
