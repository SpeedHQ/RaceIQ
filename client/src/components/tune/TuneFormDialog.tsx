import React, { useState, useCallback } from "react";
import { client } from "../../lib/rpc";
import { useQuery } from "@tanstack/react-query";
import {
  type TuneSettings,
} from "../../data/tune-catalog";
import type { TuneCategory } from "@shared/types";
import { ALL_CATEGORIES, CATEGORY_LABELS } from "./tune-constants.tsx";

// ── Default settings for new tune ───────────────────────────────────────────

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

// ── TuneFormData interface ───────────────────────────────────────────────────

export interface TuneFormData {
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  description: string;
  settings: TuneSettings;
}

// ── NumberField ──────────────────────────────────────────────────────────────

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

// ── SettingsSection ──────────────────────────────────────────────────────────

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

// ── TuneFormDialog ───────────────────────────────────────────────────────────

export function TuneFormDialog({
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
    queryFn: () => client.api.cars.$get().then((r) => r.json()),
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
      [group]: { ...(prev[group] as object), [field]: value },
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
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
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
                  <NumberField
                    label="Center %"
                    value={settings.differential.center ?? 50}
                    onChange={(v) => updateSettings("differential", "center", v)}
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
