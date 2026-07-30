import type { GameId } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { Button } from "../ui/button";
import { FillForm } from "./FillForm";
import { getSchemaForGame } from "./setup-schema";

export interface SetupTuneData {
  gameId: GameId;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  description: string;
  settings: Record<string, unknown>;
}

export interface TuneSection {
  /** JSON path of the section inside the setup object, e.g.
   *  "basicSetup.tyres". Used to detect whether the pasted JSON covers this
   *  tunable group. */
  key: string;
  label: string;
  fields: string;
}

export interface CategoryOption {
  value: string;
  label: string;
}

// ── ACC — sections / categories ──────────────────────────────────────────────
// Mirrors Kunos' ACC setup.json schema: basicSetup.{tyres,alignment,electronics,
// strategy} and advancedSetup.{mechanicalBalance,dampers,aeroBalance,drivetrain}.
export const ACC_SECTIONS: TuneSection[] = [
  { key: "basicSetup.tyres", label: "Tyres", fields: "Pressures (FL/FR/RL/RR), compound" },
  { key: "basicSetup.alignment", label: "Alignment", fields: "Camber, toe, caster, steer ratio" },
  { key: "basicSetup.electronics", label: "Electronics", fields: "TC1/TC2, ABS, ECU map, telemetry" },
  { key: "basicSetup.strategy", label: "Strategy", fields: "Fuel, tyre set, brake pads, pit strategy" },
  { key: "advancedSetup.mechanicalBalance", label: "Mechanical Balance", fields: "ARB, brake bias & power, wheel/bumpstop rates, preload" },
  { key: "advancedSetup.dampers", label: "Dampers", fields: "Bump / rebound (slow & fast) per corner" },
  { key: "advancedSetup.aeroBalance", label: "Aero & Ride", fields: "Ride height, splitter, rear wing, brake ducts" },
  { key: "advancedSetup.drivetrain", label: "Drivetrain", fields: "Differential preload" },
];

// The four in-game ACC setup types plus a wet flag. Matches the four session
// categories Kunos exposes in the setup menu.
export const ACC_CATEGORIES: CategoryOption[] = [
  { value: "qualifying", label: "Qualifying" },
  { value: "race", label: "Race" },
  { value: "safe", label: "Safe" },
  { value: "wet", label: "Wet" },
];

// ── AC EVO — sections / categories ───────────────────────────────────────────
// AC EVO broadens the setup scope beyond ACC's GT3-focused sheet: it adds
// fuel-management, engine mapping, suspension presets, and LSD coast/power
// splits (rally-style), so the categories reflect that multi-discipline scope.
export const AC_EVO_SECTIONS: TuneSection[] = [
  { key: "basicSetup.tyres", label: "Tyres", fields: "Pressures, compound, tyre set" },
  { key: "basicSetup.alignment", label: "Alignment", fields: "Camber, toe, caster, ride height" },
  { key: "basicSetup.electronics", label: "Electronics", fields: "TC, ABS, ECU map, engine braking" },
  { key: "basicSetup.strategy", label: "Strategy", fields: "Fuel, brake pads, pit stop plan" },
  { key: "advancedSetup.mechanicalBalance", label: "Mechanical Balance", fields: "ARB, brake bias, wheel rates, preload" },
  { key: "advancedSetup.dampers", label: "Dampers", fields: "Bump / rebound per corner" },
  { key: "advancedSetup.aeroBalance", label: "Aero & Ride", fields: "Ride height, wing, splitter, ducts" },
  { key: "advancedSetup.drivetrain", label: "Drivetrain", fields: "LSD power / coast / preload" },
  { key: "advancedSetup.suspension", label: "Suspension Presets", fields: "Bumpstops, packers, helper springs" },
];

// AC EVO covers road and track driving, so the categories include a broader
// mix than ACC's four in-game types.
export const AC_EVO_CATEGORIES: CategoryOption[] = [
  { value: "qualifying", label: "Qualifying" },
  { value: "race", label: "Race" },
  { value: "endurance", label: "Endurance" },
  { value: "safe", label: "Safe / Baseline" },
  { value: "wet", label: "Wet" },
  { value: "trackday", label: "Track Day" },
  { value: "road", label: "Road" },
];

function getSectionsForGame(gameId: GameId): TuneSection[] {
  if (gameId === "acc") return ACC_SECTIONS;
  if (gameId === "ac-evo") return AC_EVO_SECTIONS;
  return [];
}

export function getCategoriesForGame(gameId: GameId): CategoryOption[] {
  if (gameId === "acc") return ACC_CATEGORIES;
  if (gameId === "ac-evo") return AC_EVO_CATEGORIES;
  return [{ value: "circuit", label: "Circuit" }];
}

type Mode = "form" | "json";

/** ACC / AC-EVO tune editor. Users pick an input mode up front — fill the
 *  structured form or paste the raw setup JSON. Both modes read/write the same
 *  `settings` object, so switching modes is lossless. */
export function SetupTuneForm({
  gameId,
  cars,
  initialData,
  onSubmit,
  onCancel,
  title,
  isSubmitting,
}: {
  gameId: GameId;
  cars: { ordinal: number; name: string }[];
  initialData?: Partial<SetupTuneData>;
  onSubmit: (data: SetupTuneData) => void;
  onCancel: () => void;
  title: string;
  isSubmitting: boolean;
}) {
  const sections = getSectionsForGame(gameId);
  const categories = getCategoriesForGame(gameId);
  const schema = useMemo(() => getSchemaForGame(gameId), [gameId]);
  const defaultCategory = categories[0]?.value ?? "race";

  const [name, setName] = useState(initialData?.name ?? "");
  const [author, setAuthor] = useState(initialData?.author ?? "Me");
  const [carOrdinal, setCarOrdinal] = useState<number>(initialData?.carOrdinal ?? cars[0]?.ordinal ?? 0);
  const [category, setCategory] = useState(initialData?.category ?? defaultCategory);
  const [description, setDescription] = useState(initialData?.description ?? "");

  // Structured-form state: keep a live settings object the fill-form mutates.
  const [settings, setSettings] = useState<Record<string, unknown>>(() => (initialData?.settings as Record<string, unknown>) ?? {});
  // JSON-mode state: the textarea string (may be invalid mid-edit).
  const [jsonText, setJsonText] = useState(() => (initialData?.settings ? JSON.stringify(initialData.settings, null, 2) : "{}"));
  const [jsonError, setJsonError] = useState("");

  const [mode, setMode] = useState<Mode>("form");

  useEffect(() => {
    if (!initialData) return;
    setName(initialData.name ?? "");
    setAuthor(initialData.author ?? "Me");
    setCarOrdinal(initialData.carOrdinal ?? cars[0]?.ordinal ?? 0);
    setCategory(initialData.category ?? defaultCategory);
    setDescription(initialData.description ?? "");
    const next = (initialData.settings as Record<string, unknown>) ?? {};
    setSettings(next);
    setJsonText(initialData.settings ? JSON.stringify(initialData.settings, null, 2) : "{}");
    setJsonError("");
  }, [initialData, cars, defaultCategory]);

  // Detect which tunable sections are populated — from whichever source is
  // currently authoritative (live settings in form mode, parsed JSON in JSON
  // mode so the count updates as the user types).
  const coveredSections = useMemo(() => {
    let source: Record<string, Record<string, unknown>> | null;
    if (mode === "form") {
      source = settings as Record<string, Record<string, unknown>>;
    } else {
      try {
        source = JSON.parse(jsonText);
      } catch {
        source = null;
      }
    }
    const covered = new Set<string>();
    if (!source) return covered;
    for (const s of sections) {
      const [root, leaf] = s.key.split(".");
      if (source?.[root]?.[leaf]) covered.add(s.key);
    }
    return covered;
  }, [mode, settings, jsonText, sections]);

  // When user flips to JSON mode, seed the textarea from the live settings.
  // When user flips to form mode, parse the textarea into settings (if valid).
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(JSON.stringify(settings, null, 2));
      setJsonError("");
    } else {
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setSettings(parsed as Record<string, unknown>);
          setJsonError("");
        } else {
          setJsonError("Settings must be a JSON object");
          return;
        }
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }
    setMode(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let finalSettings: Record<string, unknown>;
    if (mode === "form") {
      finalSettings = settings;
    } else {
      try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Settings must be a JSON object");
        }
        finalSettings = parsed;
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }
    setJsonError("");
    onSubmit({ gameId, name, author, carOrdinal, category, description, settings: finalSettings });
  };

  const gameLabel = gameId === "acc" ? "ACC" : "AC EVO";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col min-h-full">
      <div className="sticky top-0 z-10 bg-app-bg border-b border-app-border flex items-center gap-3 px-4 py-2">
        <Button type="button" variant="app-ghost" size="app-sm" onClick={onCancel}>
          &larr;
        </Button>
        <h2 className="text-sm font-semibold text-app-text">{title}</h2>
        <div className="flex items-center gap-2 ml-auto">
          <Button type="button" variant="app-outline" size="app-sm" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" variant="app-primary" size="app-sm" disabled={!name || isSubmitting}>
            {isSubmitting ? m.common_saving() : m.setupform_save_tune()}
          </Button>
        </div>
      </div>

      <div className="p-6 grid grid-cols-2 gap-4 max-w-3xl">
        {/* Mode picker — first thing the user sees. Determines whether the
            settings come from the structured form or a pasted JSON blob. */}
        <div className="col-span-2 flex items-center gap-2" role="radiogroup" aria-label="Input mode">
          <span className="text-xs font-medium text-app-text-muted mr-1">{m.setupform_input_label()}</span>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "form"}
            onClick={() => switchMode("form")}
            className={`px-3 py-1 text-xs rounded border ${
              mode === "form" ? "bg-app-accent/20 border-app-accent text-app-text" : "bg-app-surface border-app-border text-app-text-muted hover:text-app-text"
            }`}
          >
            {m.setupform_fill_form()}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "json"}
            onClick={() => switchMode("json")}
            className={`px-3 py-1 text-xs rounded border ${
              mode === "json" ? "bg-app-accent/20 border-app-accent text-app-text" : "bg-app-surface border-app-border text-app-text-muted hover:text-app-text"
            }`}
          >
            {m.setupform_paste_json()}
          </button>
          {jsonError && <span className="text-[10px] text-status-danger ml-2">{jsonError}</span>}
        </div>

        <label className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-app-text-muted">{m.tune_form_name()}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-app-text-muted">{m.label_author()}</span>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            required
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-app-text-muted">{m.label_car()}</span>
          <select
            value={carOrdinal}
            onChange={(e) => setCarOrdinal(Number(e.target.value))}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          >
            {cars.map((c) => (
              <option key={c.ordinal} value={c.ordinal}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-app-text-muted">{m.label_category()}</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          >
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-app-text-muted">{m.tune_form_description()}</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
        </label>

        {sections.length > 0 && (
          <div className="col-span-2 flex items-center justify-between">
            <span className="text-xs font-medium text-app-text-muted">{m.setupform_tunable_sections()}</span>
            <span className="text-[10px] text-app-text-muted">
              {coveredSections.size} / {sections.length} {m.setupform_covered()}
            </span>
          </div>
        )}

        {mode === "form" && schema.length > 0 && <FillForm sections={schema} settings={settings} onChange={setSettings} />}

        {mode === "json" && (
          <label className="col-span-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-app-text-muted">{m.setupform_setup_json()}</span>
              {jsonError && <span className="text-[10px] text-status-danger">{jsonError}</span>}
            </div>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              className="w-full h-96 bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs font-mono text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
            />
            <p className="text-[10px] text-app-text-muted">
              Paste the full setup JSON produced by {gameLabel}. Every in-game tunable lives inside <code>basicSetup</code> or <code>advancedSetup</code> — the section counter above shows which groups
              are present.
            </p>
          </label>
        )}
      </div>
    </form>
  );
}
