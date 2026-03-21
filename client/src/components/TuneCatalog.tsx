import React, { useState, useCallback } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CATALOG_CARS,
  TUNE_CATALOG,
  getCatalogCar,
  type CatalogTune,
  type RaceStrategy,
  type TuneSettings,
} from "../data/tune-catalog";
import type { Tune, TuneCategory } from "@shared/types";
import {
  useUserTunes,
  useCatalogTunes,
  useCreateTune,
  useUpdateTune,
  useCloneCatalogTune,
} from "../hooks/queries";

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
      rows: [
        ["Final Drive", settings.gearing.finalDrive.toFixed(2)],
        ...(settings.gearing.description
          ? [["Notes", settings.gearing.description] as [string, string]]
          : []),
      ],
    },
    {
      title: "Alignment",
      rows: [
        ["Front Camber", `${settings.alignment.frontCamber.toFixed(1)}\u00B0`],
        ["Rear Camber", `${settings.alignment.rearCamber.toFixed(1)}\u00B0`],
        ["Front Toe", `${settings.alignment.frontToe.toFixed(1)}\u00B0`],
        ["Rear Toe", `${settings.alignment.rearToe.toFixed(1)}\u00B0`],
        ...(settings.alignment.frontCaster != null
          ? [
              [
                "Front Caster",
                `${settings.alignment.frontCaster.toFixed(1)}\u00B0`,
              ] as [string, string],
            ]
          : []),
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
        [
          "Front Rate",
          `${settings.springs.frontRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`,
        ],
        [
          "Rear Rate",
          `${settings.springs.rearRate.toFixed(1)} ${settings.springs.unit ?? "kgf/mm"}`,
        ],
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
      title: "Aero",
      rows: [
        [
          "Front Downforce",
          `${settings.aero.frontDownforce} ${settings.aero.unit ?? "kgf"}`,
        ],
        [
          "Rear Downforce",
          `${settings.aero.rearDownforce} ${settings.aero.unit ?? "kgf"}`,
        ],
      ],
    },
    {
      title: "Differential",
      rows: [
        ["Rear Accel", `${settings.differential.rearAccel}%`],
        ["Rear Decel", `${settings.differential.rearDecel}%`],
        ...(settings.differential.frontAccel != null
          ? [
              [
                "Front Accel",
                `${settings.differential.frontAccel}%`,
              ] as [string, string],
            ]
          : []),
        ...(settings.differential.frontDecel != null
          ? [
              [
                "Front Decel",
                `${settings.differential.frontDecel}%`,
              ] as [string, string],
            ]
          : []),
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
                <span className="text-app-text-muted whitespace-nowrap">
                  {label}
                </span>
                <span
                  className="text-app-text font-mono whitespace-nowrap"
                  style={
                    label === "Notes"
                      ? { whiteSpace: "normal", textAlign: "right" }
                      : undefined
                  }
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Strategy panel ──────────────────────────────────────────────────────────

const CONDITION_COLORS: Record<string, string> = {
  Dry: "bg-amber-500/20 text-amber-400",
  Wet: "bg-cyan-500/20 text-cyan-400",
};

function StrategyPanel({
  strategies,
  tuneId,
}: {
  strategies: RaceStrategy[];
  tuneId: string;
}) {
  const [activeCondition, setActiveCondition] = useState(
    strategies[0].condition,
  );
  const strategy =
    strategies.find((s) => s.condition === activeCondition) ?? strategies[0];

  return (
    <div className="rounded-lg bg-app-bg/85 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">
          Race Strategy
        </h4>
        <div className="flex gap-1">
          {strategies.map((s) => (
            <button
              key={`${tuneId}-${s.condition}`}
              onClick={() => setActiveCondition(s.condition)}
              className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded transition-colors ${
                activeCondition === s.condition
                  ? CONDITION_COLORS[s.condition]
                  : "text-app-text-muted hover:text-app-text-secondary"
              }`}
            >
              {s.condition}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.totalLaps}
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Laps
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.fuelLoadPercent}%
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Fuel Load
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.pitStops}
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Pit Stops
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-bold text-app-text font-mono leading-tight">
            {strategy.tireCompound}
          </div>
          <div className="text-[10px] text-app-text-muted uppercase leading-tight">
            Tire
          </div>
        </div>
      </div>
      {strategy.pitLaps && strategy.pitLaps.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs mb-2">
          <span className="text-app-text-muted">Pit on lap:</span>
          {strategy.pitLaps.map((lap) => (
            <span
              key={lap}
              className="font-mono px-1.5 py-0.5 rounded bg-app-surface text-app-text ring-1 ring-app-border"
            >
              {lap}
            </span>
          ))}
        </div>
      )}
      {strategy.notes && (
        <p className="text-xs text-app-text-secondary">{strategy.notes}</p>
      )}
    </div>
  );
}

// ── Constants ───────────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  circuit: (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20M2 12h20" />
    </svg>
  ),
  wet: (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l-3.5 11a4 4 0 1 0 7 0L12 2z" />
    </svg>
  ),
  "low-drag": (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  ),
  stable: (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22V2M2 12l10-10 10 10" />
    </svg>
  ),
  "track-specific": (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
};

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

// ── Default settings for new tune ───────────────────────────────────────────

function defaultTuneSettings(): TuneSettings {
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

// ── Tune Form Dialog ────────────────────────────────────────────────────────

interface TuneFormData {
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  description: string;
  settings: TuneSettings;
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-app-text-muted whitespace-nowrap">{label}</span>
      <input
        type="number"
        value={value}
        step={step ?? 0.1}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-20 bg-app-bg/85 border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text font-mono text-right focus:outline-none focus:ring-1 focus:ring-app-accent"
      />
    </label>
  );
}

function SettingsSection({
  title,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg ring-1 ring-app-border overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex items-center justify-between bg-app-surface/85 hover:bg-app-surface transition-colors"
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
      {isOpen && <div className="p-3 space-y-1">{children}</div>}
    </div>
  );
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
  const [category, setCategory] = useState<TuneCategory>(
    initialData?.category ?? "circuit",
  );
  const [description, setDescription] = useState(
    initialData?.description ?? "",
  );
  const [settings, setSettings] = useState<TuneSettings>(
    initialData?.settings ?? defaultTuneSettings(),
  );
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [carSearchQuery, setCarSearchQuery] = useState("");
  const [carDropOpen, setCarDropOpen] = useState(false);
  const { data: allCars = [] } = useQuery<{ ordinal: number; name: string }[]>({
    queryKey: ["all-cars"],
    queryFn: () => fetch("/api/cars").then((r) => r.json()),
    staleTime: Infinity,
  });
  const filteredFormCars = carSearchQuery
    ? allCars.filter((c) => c.name.toLowerCase().includes(carSearchQuery.toLowerCase())).slice(0, 20)
    : allCars.slice(0, 20);
  const selectedCarName = allCars.find((c) => c.ordinal === carOrdinal)?.name ?? (carOrdinal ? `Car #${carOrdinal}` : "Select car...");

  // Reset form when dialog opens with new data
  const resetForm = useCallback(() => {
    setName(initialData?.name ?? "");
    setAuthor(initialData?.author ?? "Me");
    setCarOrdinal(initialData?.carOrdinal ?? 2860);
    setCategory(initialData?.category ?? "circuit");
    setDescription(initialData?.description ?? "");
    setSettings(initialData?.settings ?? defaultTuneSettings());
    setOpenSections(new Set());
    setJsonMode(false);
    setJsonText("");
    setJsonError("");
  }, [initialData]);

  // Reset when opening
  useState(() => {
    if (isOpen) resetForm();
  });

  const toggleSection = (s: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const updateSettings = <K extends keyof TuneSettings>(
    group: K,
    field: string,
    value: number,
  ) => {
    setSettings((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  };

  const handleJsonParse = () => {
    try {
      const parsed = JSON.parse(jsonText);
      // Accept either a full tune object (with .settings) or just settings
      const s = parsed.settings ?? parsed;
      // Validate basic structure
      const required = [
        "tires",
        "gearing",
        "alignment",
        "antiRollBars",
        "springs",
        "damping",
        "aero",
        "differential",
        "brakes",
      ];
      for (const key of required) {
        if (!s[key]) throw new Error(`Missing section: ${key}`);
      }
      setSettings(s);
      // If full tune object, also populate metadata
      if (parsed.name) setName(parsed.name);
      if (parsed.author) setAuthor(parsed.author);
      if (parsed.carOrdinal) setCarOrdinal(parsed.carOrdinal);
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
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div className="relative bg-app-surface rounded-xl ring-1 ring-app-border shadow-2xl w-full max-w-lg max-h-[calc(100vh-4rem)] overflow-auto mx-4">
        <form onSubmit={handleSubmit}>
          <div className="sticky top-0 bg-app-surface px-4 py-3 border-b border-app-border flex items-center justify-between z-10">
            <h2 className="text-sm font-bold text-app-text">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-app-text-muted hover:text-app-text text-lg leading-none"
            >
              x
            </button>
          </div>

          <div className="p-4 space-y-3">
            {/* Metadata */}
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 space-y-1">
                <span className="text-xs font-medium text-app-text-muted">
                  Name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-app-text-muted">
                  Author
                </span>
                <input
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  required
                  className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                />
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
                <span className="text-xs font-medium text-app-text-muted">
                  Category
                </span>
                <select
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value as TuneCategory)
                  }
                  className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                >
                  {ALL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-app-text-muted">
                  Description
                </span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
                />
              </label>
            </div>

            {/* JSON Import toggle */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setJsonMode(!jsonMode)}
                className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
                  jsonMode
                    ? "bg-app-accent/20 text-app-accent"
                    : "text-app-text-muted hover:text-app-text-secondary"
                }`}
              >
                JSON Import
              </button>
              {!jsonMode && (
                <span className="text-[10px] text-app-text-muted">
                  Or fill in sections below
                </span>
              )}
            </div>

            {jsonMode ? (
              <div className="space-y-2">
                <textarea
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setJsonError("");
                  }}
                  placeholder='Paste tune JSON (full tune object or just settings)...'
                  rows={10}
                  className="w-full bg-app-bg/85 border border-app-border rounded px-2 py-1.5 text-xs text-app-text font-mono focus:outline-none focus:ring-1 focus:ring-app-accent resize-y"
                />
                {jsonError && (
                  <p className="text-xs text-red-400">{jsonError}</p>
                )}
                <button
                  type="button"
                  onClick={handleJsonParse}
                  className="text-xs px-3 py-1.5 rounded bg-app-accent/20 text-app-accent hover:bg-app-accent/30 transition-colors"
                >
                  Parse & Populate
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Tires */}
                <SettingsSection
                  title="Tires"
                  isOpen={openSections.has("tires")}
                  onToggle={() => toggleSection("tires")}
                >
                  <NumberField
                    label="Front Pressure (bar)"
                    value={settings.tires.frontPressure}
                    onChange={(v) => updateSettings("tires", "frontPressure", v)}
                    step={0.01}
                  />
                  <NumberField
                    label="Rear Pressure (bar)"
                    value={settings.tires.rearPressure}
                    onChange={(v) => updateSettings("tires", "rearPressure", v)}
                    step={0.01}
                  />
                </SettingsSection>

                {/* Gearing */}
                <SettingsSection
                  title="Gearing"
                  isOpen={openSections.has("gearing")}
                  onToggle={() => toggleSection("gearing")}
                >
                  <NumberField
                    label="Final Drive"
                    value={settings.gearing.finalDrive}
                    onChange={(v) => updateSettings("gearing", "finalDrive", v)}
                    step={0.01}
                  />
                </SettingsSection>

                {/* Alignment */}
                <SettingsSection
                  title="Alignment"
                  isOpen={openSections.has("alignment")}
                  onToggle={() => toggleSection("alignment")}
                >
                  <NumberField
                    label="Front Camber"
                    value={settings.alignment.frontCamber}
                    onChange={(v) => updateSettings("alignment", "frontCamber", v)}
                  />
                  <NumberField
                    label="Rear Camber"
                    value={settings.alignment.rearCamber}
                    onChange={(v) => updateSettings("alignment", "rearCamber", v)}
                  />
                  <NumberField
                    label="Front Toe"
                    value={settings.alignment.frontToe}
                    onChange={(v) => updateSettings("alignment", "frontToe", v)}
                  />
                  <NumberField
                    label="Rear Toe"
                    value={settings.alignment.rearToe}
                    onChange={(v) => updateSettings("alignment", "rearToe", v)}
                  />
                  <NumberField
                    label="Front Caster"
                    value={settings.alignment.frontCaster ?? 5.0}
                    onChange={(v) => updateSettings("alignment", "frontCaster", v)}
                  />
                </SettingsSection>

                {/* Anti-Roll Bars */}
                <SettingsSection
                  title="Anti-Roll Bars"
                  isOpen={openSections.has("arb")}
                  onToggle={() => toggleSection("arb")}
                >
                  <NumberField
                    label="Front"
                    value={settings.antiRollBars.front}
                    onChange={(v) => updateSettings("antiRollBars", "front", v)}
                  />
                  <NumberField
                    label="Rear"
                    value={settings.antiRollBars.rear}
                    onChange={(v) => updateSettings("antiRollBars", "rear", v)}
                  />
                </SettingsSection>

                {/* Springs */}
                <SettingsSection
                  title="Springs"
                  isOpen={openSections.has("springs")}
                  onToggle={() => toggleSection("springs")}
                >
                  <NumberField
                    label="Front Rate"
                    value={settings.springs.frontRate}
                    onChange={(v) => updateSettings("springs", "frontRate", v)}
                    step={1}
                  />
                  <NumberField
                    label="Rear Rate"
                    value={settings.springs.rearRate}
                    onChange={(v) => updateSettings("springs", "rearRate", v)}
                    step={1}
                  />
                  <NumberField
                    label="Front Height (cm)"
                    value={settings.springs.frontHeight}
                    onChange={(v) => updateSettings("springs", "frontHeight", v)}
                  />
                  <NumberField
                    label="Rear Height (cm)"
                    value={settings.springs.rearHeight}
                    onChange={(v) => updateSettings("springs", "rearHeight", v)}
                  />
                </SettingsSection>

                {/* Damping */}
                <SettingsSection
                  title="Damping"
                  isOpen={openSections.has("damping")}
                  onToggle={() => toggleSection("damping")}
                >
                  <NumberField
                    label="Front Rebound"
                    value={settings.damping.frontRebound}
                    onChange={(v) => updateSettings("damping", "frontRebound", v)}
                  />
                  <NumberField
                    label="Rear Rebound"
                    value={settings.damping.rearRebound}
                    onChange={(v) => updateSettings("damping", "rearRebound", v)}
                  />
                  <NumberField
                    label="Front Bump"
                    value={settings.damping.frontBump}
                    onChange={(v) => updateSettings("damping", "frontBump", v)}
                  />
                  <NumberField
                    label="Rear Bump"
                    value={settings.damping.rearBump}
                    onChange={(v) => updateSettings("damping", "rearBump", v)}
                  />
                </SettingsSection>

                {/* Aero */}
                <SettingsSection
                  title="Aero"
                  isOpen={openSections.has("aero")}
                  onToggle={() => toggleSection("aero")}
                >
                  <NumberField
                    label="Front Downforce"
                    value={settings.aero.frontDownforce}
                    onChange={(v) => updateSettings("aero", "frontDownforce", v)}
                    step={1}
                  />
                  <NumberField
                    label="Rear Downforce"
                    value={settings.aero.rearDownforce}
                    onChange={(v) => updateSettings("aero", "rearDownforce", v)}
                    step={1}
                  />
                </SettingsSection>

                {/* Differential */}
                <SettingsSection
                  title="Differential"
                  isOpen={openSections.has("diff")}
                  onToggle={() => toggleSection("diff")}
                >
                  <NumberField
                    label="Rear Accel %"
                    value={settings.differential.rearAccel}
                    onChange={(v) => updateSettings("differential", "rearAccel", v)}
                    step={1}
                  />
                  <NumberField
                    label="Rear Decel %"
                    value={settings.differential.rearDecel}
                    onChange={(v) => updateSettings("differential", "rearDecel", v)}
                    step={1}
                  />
                  <NumberField
                    label="Front Accel %"
                    value={settings.differential.frontAccel ?? 0}
                    onChange={(v) => updateSettings("differential", "frontAccel", v)}
                    step={1}
                  />
                  <NumberField
                    label="Front Decel %"
                    value={settings.differential.frontDecel ?? 0}
                    onChange={(v) => updateSettings("differential", "frontDecel", v)}
                    step={1}
                  />
                </SettingsSection>

                {/* Brakes */}
                <SettingsSection
                  title="Brakes"
                  isOpen={openSections.has("brakes")}
                  onToggle={() => toggleSection("brakes")}
                >
                  <NumberField
                    label="Balance %"
                    value={settings.brakes.balance}
                    onChange={(v) => updateSettings("brakes", "balance", v)}
                    step={1}
                  />
                  <NumberField
                    label="Pressure %"
                    value={settings.brakes.pressure}
                    onChange={(v) => updateSettings("brakes", "pressure", v)}
                    step={1}
                  />
                </SettingsSection>
              </div>
            )}
          </div>

          <div className="sticky bottom-0 bg-app-surface px-4 py-3 border-t border-app-border flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded border border-app-border text-app-text-secondary hover:text-app-text transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name || isSubmitting}
              className="text-xs px-3 py-1.5 rounded bg-app-accent text-white hover:bg-app-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Catalog Tune Card ───────────────────────────────────────────────────────

function CatalogTuneCard({
  tune,
  isExpanded,
  onToggle,
  showCar,
  onClone,
  isCloning,
}: {
  tune: CatalogTune;
  isExpanded: boolean;
  onToggle: () => void;
  showCar?: boolean;
  onClone: () => void;
  isCloning: boolean;
}) {
  return (
    <div className="rounded-xl bg-app-surface/85 ring-1 ring-app-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-app-surface transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-app-text">{tune.name}</span>
              {showCar && (
                <span className="text-[10px] font-mono text-app-text-muted">
                  {getCatalogCar(tune.carOrdinal)?.name ??
                    `Car ${tune.carOrdinal}`}
                </span>
              )}
              <span
                className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${CATEGORY_COLORS[tune.category]}`}
              >
                {CATEGORY_ICONS[tune.category]}
                {CATEGORY_LABELS[tune.category]}
              </span>
            </div>
            <p
              className={`text-xs text-app-text-muted mt-0.5 ${isExpanded ? "" : "line-clamp-1"}`}
            >
              {tune.description}
            </p>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-app-text-muted shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-app-border max-w-2xl">
          <div className="flex items-center gap-2 pt-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClone();
              }}
              disabled={isCloning}
              className="text-[10px] font-semibold uppercase px-2 py-1 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-50 transition-colors"
            >
              {isCloning ? "Cloning..." : "Clone to My Tunes"}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-1">
                Strengths
              </h4>
              <ul className="space-y-0.5">
                {tune.strengths.map((s) => (
                  <li
                    key={s}
                    className="text-xs text-app-text-secondary flex items-start gap-1.5"
                  >
                    <span className="text-green-400 mt-0.5">+</span> {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-1">
                Weaknesses
              </h4>
              <ul className="space-y-0.5">
                {tune.weaknesses.map((w) => (
                  <li
                    key={w}
                    className="text-xs text-app-text-secondary flex items-start gap-1.5"
                  >
                    <span className="text-red-400 mt-0.5">-</span> {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {tune.bestTracks && tune.bestTracks.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted mb-1">
                Best Tracks
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {tune.bestTracks.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg/85 text-app-text-secondary ring-1 ring-app-border"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {tune.strategies && tune.strategies.length > 0 && (
            <StrategyPanel strategies={tune.strategies} tuneId={tune.id} />
          )}

          <TuneSettingsPanel settings={tune.settings} />

          <div className="text-[10px] text-app-text-muted pt-1">
            by {tune.author}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

export function TuneCatalog() {
  // UI state
  const [selectedCar, setSelectedCar] = useState<number | null>(null);
  const [expandedTune, setExpandedTune] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [carSearch, setCarSearch] = useState("");
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);
  const [trackSearch, setTrackSearch] = useState("");
  const [catalogPage, setCatalogPage] = useState(0);

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editingTune, setEditingTune] = useState<Tune | null>(null);

  // API queries
  const { data: userTunes = [] } = useUserTunes();
  const { data: apiCatalogTunes = [] } = useCatalogTunes();

  // Mutations
  const createTune = useCreateTune();
  const updateTune = useUpdateTune();
  const cloneTune = useCloneCatalogTune();

  // Use local catalog as fallback, API catalog when available
  const catalogTunes: CatalogTune[] =
    apiCatalogTunes.length > 0 ? apiCatalogTunes : TUNE_CATALOG;

  // Car filter
  const filteredCars = carSearch
    ? CATALOG_CARS.filter((c) =>
        c.name.toLowerCase().includes(carSearch.toLowerCase()),
      )
    : CATALOG_CARS;

  const car = selectedCar != null ? getCatalogCar(selectedCar) : null;

  // Filter catalog tunes
  const allCatalogTunes =
    selectedCar != null
      ? catalogTunes.filter((t) => t.carOrdinal === selectedCar)
      : catalogTunes;
  const trackQuery = trackSearch.toLowerCase();
  const filteredCatalogTunes = allCatalogTunes.filter((t) => {
    if (categoryFilter && t.category !== categoryFilter) return false;
    if (
      trackQuery &&
      !t.bestTracks?.some((tr) => tr.toLowerCase().includes(trackQuery))
    )
      return false;
    return true;
  });

  // Paginate catalog tunes
  const totalCatalogPages = Math.ceil(
    filteredCatalogTunes.length / PAGE_SIZE,
  );
  const paginatedCatalogTunes = filteredCatalogTunes.slice(
    catalogPage * PAGE_SIZE,
    (catalogPage + 1) * PAGE_SIZE,
  );

  const categories = [
    ...new Set(allCatalogTunes.map((t) => t.category)),
  ];

  // Handlers
  const handleCreateSubmit = (data: TuneFormData) => {
    createTune.mutate(data as any, {
      onSuccess: () => {
        setFormOpen(false);
      },
    });
  };

  const handleEditSubmit = (data: TuneFormData) => {
    if (!editingTune) return;
    updateTune.mutate(
      { id: editingTune.id, ...data } as any,
      {
        onSuccess: () => {
          setEditingTune(null);
          setFormOpen(false);
        },
      },
    );
  };

  const handleClone = (catalogId: string) => {
    cloneTune.mutate(catalogId);
  };

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-app-text">Tune Catalog</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
              {selectedCar != null
                ? "Stock Spec"
                : `${catalogTunes.length} Tunes`}
            </span>
            {car && (
              <span className="text-[10px] font-mono text-app-text-muted">
                {car.class} {car.pi}
              </span>
            )}
          </div>
          <p className="text-xs text-app-text-muted">
            Reference tunes — clone to your collection to edit
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/tunes/manage"
            className="text-xs px-3 py-1.5 rounded bg-app-accent text-white hover:bg-app-accent/80 transition-colors flex items-center gap-1.5 no-underline"
          >
            My Tunes
            {userTunes.length > 0 && (
              <span className="bg-white/20 rounded-full px-1.5 py-0 text-[10px] font-bold">
                {userTunes.length}
              </span>
            )}
          </Link>
          <input
            type="text"
            value={trackSearch}
            onChange={(e) => {
              setTrackSearch(e.target.value);
              setCatalogPage(0);
            }}
            placeholder="Search tracks..."
            className="bg-app-dropdown text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border-input focus:outline-none focus:ring-1 focus:ring-app-accent w-36"
          />
          <div className="relative">
            <input
              type="text"
              value={
                carDropdownOpen
                  ? carSearch
                  : selectedCar != null
                    ? (getCatalogCar(selectedCar)?.name ?? `Car ${selectedCar}`)
                    : ""
              }
              onChange={(e) => {
                setCarSearch(e.target.value);
                setCarDropdownOpen(true);
              }}
              onFocus={() => {
                setCarDropdownOpen(true);
                setCarSearch("");
              }}
              onBlur={() =>
                setTimeout(() => setCarDropdownOpen(false), 150)
              }
              placeholder="Filter by car..."
              className="bg-app-surface-alt text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border-input focus:outline-none focus:ring-1 focus:ring-app-accent w-48"
            />
            {carDropdownOpen && (
              <div className="absolute right-0 mt-1 w-56 max-h-60 overflow-auto rounded-lg bg-app-dropdown border border-app-border z-50 shadow-lg">
                {!carSearch && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedCar(null);
                      setExpandedTune(null);
                      setCategoryFilter(null);
                      setCarSearch("");
                      setCarDropdownOpen(false);
                      setCatalogPage(0);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${
                      selectedCar == null
                        ? "text-app-accent"
                        : "text-app-text"
                    }`}
                  >
                    All Cars
                  </button>
                )}
                {filteredCars.map((c) => (
                  <button
                    key={c.ordinal}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedCar(c.ordinal);
                      setExpandedTune(null);
                      setCategoryFilter(null);
                      setCarSearch("");
                      setCarDropdownOpen(false);
                      setCatalogPage(0);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-app-accent/20 transition-colors ${
                      selectedCar === c.ordinal
                        ? "text-app-accent"
                        : "text-app-text"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {filteredCars.length === 0 && (
                  <div className="px-3 py-2 text-xs text-app-text-muted">
                    No cars found
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Category filters */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setCategoryFilter(null)}
          className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
            categoryFilter === null
              ? "bg-app-accent/20 text-app-accent"
              : "text-app-text-muted hover:text-app-text-secondary"
          }`}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => {
              setCategoryFilter(categoryFilter === cat ? null : cat);
              setCatalogPage(0);
            }}
            className={`text-[10px] font-semibold uppercase px-2 py-1 rounded transition-colors ${
              categoryFilter === cat
                ? (CATEGORY_COLORS[cat] ?? "bg-gray-500/20 text-gray-400")
                : "text-app-text-muted hover:text-app-text-secondary"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              {CATEGORY_ICONS[cat]}
              {CATEGORY_LABELS[cat] ?? cat}
            </span>
          </button>
        ))}
      </div>

      {/* Catalog Content */}
      <div className="space-y-2">
        {paginatedCatalogTunes.map((tune) => (
          <CatalogTuneCard
            key={tune.id}
            tune={tune}
            isExpanded={expandedTune === `catalog-${tune.id}`}
            onToggle={() =>
              setExpandedTune(
                expandedTune === `catalog-${tune.id}`
                  ? null
                  : `catalog-${tune.id}`,
              )
            }
            showCar={selectedCar == null}
            onClone={() => handleClone(tune.id)}
            isCloning={cloneTune.isPending}
          />
        ))}
      </div>

      {filteredCatalogTunes.length === 0 && (
        <div className="text-center py-12 text-app-text-muted text-sm">
          No catalog tunes found for this filter.
        </div>
      )}

      {totalCatalogPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setCatalogPage((p) => Math.max(0, p - 1))}
            disabled={catalogPage === 0}
            className="text-xs px-3 py-1 rounded border border-app-border text-app-text-secondary hover:text-app-text disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span className="text-xs text-app-text-muted">
            {catalogPage + 1} / {totalCatalogPages}
          </span>
          <button
            onClick={() =>
              setCatalogPage((p) =>
                Math.min(totalCatalogPages - 1, p + 1),
              )
            }
            disabled={catalogPage >= totalCatalogPages - 1}
            className="text-xs px-3 py-1 rounded border border-app-border text-app-text-secondary hover:text-app-text disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}


      {/* Create / Edit Dialog */}
      <TuneFormDialog
        isOpen={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingTune(null);
        }}
        initialData={
          editingTune
            ? {
                name: editingTune.name,
                author: editingTune.author,
                carOrdinal: editingTune.carOrdinal,
                category: editingTune.category,
                description: editingTune.description,
                settings: editingTune.settings,
              }
            : selectedCar != null
              ? { carOrdinal: selectedCar }
              : undefined
        }
        onSubmit={editingTune ? handleEditSubmit : handleCreateSubmit}
        title={editingTune ? `Edit: ${editingTune.name}` : "Create New Tune"}
        isSubmitting={createTune.isPending || updateTune.isPending}
      />
    </div>
  );
}
