import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import type { GameId } from "@shared/types";

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

function getCategoriesForGame(gameId: GameId): CategoryOption[] {
  if (gameId === "acc") return ACC_CATEGORIES;
  if (gameId === "ac-evo") return AC_EVO_CATEGORIES;
  return [{ value: "circuit", label: "Circuit" }];
}

/** Simple form for ACC / AC-EVO tunes. Their setup schemas are game-native
 *  JSON blobs rather than Forza's `TuneSettings`, so the UI captures metadata
 *  and lets the user paste / edit the raw setup object directly. The section
 *  list shows every tunable group the game's JSON can contain. */
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
  const defaultCategory = categories[0]?.value ?? "race";

  const [name, setName] = useState(initialData?.name ?? "");
  const [author, setAuthor] = useState(initialData?.author ?? "Me");
  const [carOrdinal, setCarOrdinal] = useState<number>(initialData?.carOrdinal ?? cars[0]?.ordinal ?? 0);
  const [category, setCategory] = useState(initialData?.category ?? defaultCategory);
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [jsonText, setJsonText] = useState(() =>
    initialData?.settings ? JSON.stringify(initialData.settings, null, 2) : "{}",
  );
  const [jsonError, setJsonError] = useState("");

  useEffect(() => {
    if (!initialData) return;
    setName(initialData.name ?? "");
    setAuthor(initialData.author ?? "Me");
    setCarOrdinal(initialData.carOrdinal ?? cars[0]?.ordinal ?? 0);
    setCategory(initialData.category ?? defaultCategory);
    setDescription(initialData.description ?? "");
    setJsonText(initialData.settings ? JSON.stringify(initialData.settings, null, 2) : "{}");
    setJsonError("");
  }, [initialData, cars, defaultCategory]);

  // Detect which tunable sections the user's pasted JSON actually populates —
  // purely a visual aid; validation doesn't require any particular section.
  const coveredSections = (() => {
    let parsed: Record<string, Record<string, unknown>>;
    try { parsed = JSON.parse(jsonText); } catch { return new Set<string>(); }
    const covered = new Set<string>();
    for (const s of sections) {
      const [root, leaf] = s.key.split(".");
      if (parsed?.[root]?.[leaf]) covered.add(s.key);
    }
    return covered;
  })();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let settings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Settings must be a JSON object");
      }
      settings = parsed;
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    setJsonError("");
    onSubmit({ gameId, name, author, carOrdinal, category, description, settings });
  };

  const gameLabel = gameId === "acc" ? "ACC" : "AC EVO";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col min-h-full">
      <div className="sticky top-0 z-10 bg-app-bg border-b border-app-border flex items-center gap-3 px-4 py-2">
        <Button type="button" variant="app-ghost" size="app-sm" onClick={onCancel}>&larr;</Button>
        <h2 className="text-sm font-semibold text-app-text">{title}</h2>
        <div className="flex items-center gap-2 ml-auto">
          <Button type="button" variant="app-outline" size="app-sm" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="app-primary" size="app-sm" disabled={!name || isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Tune"}
          </Button>
        </div>
      </div>

      <div className="p-6 grid grid-cols-2 gap-4 max-w-3xl">
        <label className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-app-text-muted">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-app-text-muted">Author</span>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            required
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-app-text-muted">Car</span>
          <select
            value={carOrdinal}
            onChange={(e) => setCarOrdinal(Number(e.target.value))}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          >
            {cars.map((c) => (
              <option key={c.ordinal} value={c.ordinal}>{c.name}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-app-text-muted">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          >
            {categories.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>

        <label className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-app-text-muted">Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
        </label>

        {sections.length > 0 && (
          <div className="col-span-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-app-text-muted">Tunable sections</span>
              <span className="text-[10px] text-app-text-muted">{coveredSections.size} / {sections.length} covered</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {sections.map((s) => {
                const isCovered = coveredSections.has(s.key);
                return (
                  <div
                    key={s.key}
                    className={`rounded-lg p-2 ring-1 ${
                      isCovered
                        ? "bg-emerald-500/5 ring-emerald-500/30"
                        : "bg-app-surface ring-app-border"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-app-text">{s.label}</span>
                      <span
                        className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                          isCovered
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-app-bg text-app-text-muted"
                        }`}
                      >
                        {isCovered ? "set" : "—"}
                      </span>
                    </div>
                    <div className="text-[10px] text-app-text-muted mt-0.5">{s.fields}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <label className="col-span-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-app-text-muted">Setup JSON</span>
            {jsonError && <span className="text-[10px] text-red-400">{jsonError}</span>}
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            className="w-full h-96 bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs font-mono text-app-text focus:outline-none focus:ring-1 focus:ring-app-accent"
          />
          <p className="text-[10px] text-app-text-muted">
            Paste the full setup JSON produced by {gameLabel}. Every in-game tunable
            lives inside <code>basicSetup</code> or <code>advancedSetup</code> —
            the sections above show which groups are present.
          </p>
        </label>
      </div>
    </form>
  );
}
