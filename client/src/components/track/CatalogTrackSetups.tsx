import { SetupSettingsPanel } from "@/components/setup-tune/SetupSettingsPanel";
import type { RawUserTune } from "@/components/tune/browser/buildRows";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { useCatalogTunes, useResolveNames, useUserTunes } from "@/hooks/queries";
import { tracksMatch } from "@/lib/track-match";
import type { GameId, TuneSettings } from "@shared/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

// Normalised community-or-user setup row for the panel list.
interface SetupRow {
  id: string;
  name: string;
  carOrdinal: number;
  category: string;
  trackOrdinal: number | null;
  bestTracks?: string[];
  description: string;
  settings: unknown;
  sourceLabel: string;
}

// Category → short badge shown in the list row and detail header.
const CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  circuit: { label: "CIR", cls: "bg-blue-500/20 text-blue-300" },
  wet: { label: "WET", cls: "bg-cyan-500/20 text-cyan-300" },
  "low-drag": { label: "LD", cls: "bg-red-500/20 text-red-300" },
  stable: { label: "STB", cls: "bg-green-500/20 text-green-300" },
  "track-specific": { label: "TRK", cls: "bg-amber-500/20 text-amber-300" },
};
const DEFAULT_BADGE = { label: "SET", cls: "bg-app-surface-alt text-app-text-muted" };

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const fmt = (n: unknown, d = 2) => (isNum(n) ? n.toFixed(d) : "—");

/** Does a catalog/user tune belong to a track? Matches by explicit trackOrdinal
 *  or a fuzzy bestTracks name match. (Car-scoped tunes with neither — most of
 *  Forza's "circuit" catalog — deliberately don't attach to any track page.) */
export function tuneMatchesTrack(tune: { trackOrdinal?: number | null; bestTracks?: string[] }, track: { ordinal: number; name: string; variant: string }): boolean {
  if (tune.trackOrdinal != null && tune.trackOrdinal === track.ordinal) return true;
  if (tune.bestTracks?.some((bt) => tracksMatch(bt, track.name, track.variant))) return true;
  return false;
}

/** Forza's flat TuneSettings rendered in the same grouped grid the F1/ACC
 *  setup detail uses (a labelled value list per section). */
function ForzaSettingsGrid({ s }: { s: Partial<TuneSettings> }) {
  // A row is only emitted when its value is a real number (or present string) —
  // partial user tunes may cover a subset, matching SetupSettingsPanel's skip.
  const num = (v: unknown, unit: string, d = 1): [boolean, string] => [isNum(v), `${fmt(v, d)}${unit}`];
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: "Tires",
      rows: rowsOf(
        ["Front Pressure", ...num(s.tires?.frontPressure, " bar", 2)],
        ["Rear Pressure", ...num(s.tires?.rearPressure, " bar", 2)],
        ["Compound", !!s.tires?.compound, s.tires?.compound ?? ""],
      ),
    },
    {
      title: "Gearing",
      rows: rowsOf(["Final Drive", ...num(s.gearing?.finalDrive, "", 2)], ["Top Speed", ...num(s.gearing?.topSpeedKph, " kph", 0)]),
    },
    {
      title: "Alignment",
      rows: rowsOf(
        ["F Camber", ...num(s.alignment?.frontCamber, "°")],
        ["R Camber", ...num(s.alignment?.rearCamber, "°")],
        ["F Toe", ...num(s.alignment?.frontToe, "°")],
        ["R Toe", ...num(s.alignment?.rearToe, "°")],
        ["Caster", ...num(s.alignment?.frontCaster, "°")],
      ),
    },
    {
      title: "Anti-Roll Bars",
      rows: rowsOf(["Front", ...num(s.antiRollBars?.front, "")], ["Rear", ...num(s.antiRollBars?.rear, "")]),
    },
    {
      title: "Springs",
      rows: rowsOf(
        ["F Rate", ...num(s.springs?.frontRate, "")],
        ["R Rate", ...num(s.springs?.rearRate, "")],
        ["F Height", ...num(s.springs?.frontHeight, "")],
        ["R Height", ...num(s.springs?.rearHeight, "")],
      ),
    },
    {
      title: "Damping",
      rows: rowsOf(
        ["F Rebound", ...num(s.damping?.frontRebound, "")],
        ["R Rebound", ...num(s.damping?.rearRebound, "")],
        ["F Bump", ...num(s.damping?.frontBump, "")],
        ["R Bump", ...num(s.damping?.rearBump, "")],
      ),
    },
    {
      title: "Aero",
      rows: rowsOf(["Front", ...num(s.aero?.frontDownforce, s.aero?.unit ? ` ${s.aero.unit}` : "", 0)], ["Rear", ...num(s.aero?.rearDownforce, s.aero?.unit ? ` ${s.aero.unit}` : "", 0)]),
    },
    {
      title: "Differential",
      rows: rowsOf(
        ["Rear Accel", ...num(s.differential?.rearAccel, "%", 0)],
        ["Rear Decel", ...num(s.differential?.rearDecel, "%", 0)],
        ["Front Accel", ...num(s.differential?.frontAccel, "%", 0)],
        ["Front Decel", ...num(s.differential?.frontDecel, "%", 0)],
        ["Center", ...num(s.differential?.center, "%", 0)],
      ),
    },
    {
      title: "Brakes",
      rows: rowsOf(["Balance", ...num(s.brakes?.balance, "%", 0)], ["Pressure", ...num(s.brakes?.pressure, "%", 0)]),
    },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="w-full columns-1 gap-3 md:columns-2 xl:columns-3">
      {groups.map((g) => (
        <div key={g.title} className="mb-3 break-inside-avoid rounded-lg bg-app-bg p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{g.title}</h4>
          <div className="space-y-0">
            {g.rows.map(([label, value]) => (
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

// Keep only rows flagged present; each arg is [label, present, value].
function rowsOf(...entries: [string, boolean, string][]): [string, string][] {
  return entries.filter(([, present]) => present).map(([label, , value]) => [label, value]);
}

/** Master-detail community setups panel for the catalog-driven games (Forza,
 *  AC-EVO). Same shell as the ACC / F1 track setup panels — a filterable,
 *  selectable list on the left and a read-only settings grid on the right —
 *  minus the download/video pieces those games carry (this data has none). */
export function CatalogTrackSetups({
  gameId,
  trackName,
  trackVariant,
  trackOrdinal,
}: {
  gameId: GameId;
  trackName: string;
  trackVariant: string;
  trackOrdinal: number;
}) {
  const search = useSearch({ strict: false }) as { setup?: string };
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterCar, setFilterCar] = useState("");

  const { data: catalog = [] } = useCatalogTunes();
  const { data: userTunes = [] } = useUserTunes(gameId);

  // Community catalog + user setups, normalised into one row shape (keeping
  // bestTracks, which buildRows drops but Forza's name-based matching needs).
  const rows: SetupRow[] = useMemo(() => {
    const community: SetupRow[] = catalog.map((t) => ({
      id: `community:${t.id}`,
      name: t.name,
      carOrdinal: t.carOrdinal,
      category: t.category,
      trackOrdinal: t.trackOrdinal ?? null,
      bestTracks: t.bestTracks,
      description: t.description ?? "",
      settings: t.settings,
      sourceLabel: t.sourceName || "Community",
    }));
    const mine: SetupRow[] = (userTunes as RawUserTune[]).map((t) => ({
      id: `user:${t.id}`,
      name: t.name,
      carOrdinal: t.carOrdinal,
      category: t.category,
      trackOrdinal: t.trackOrdinal ?? null,
      description: t.description ?? "",
      settings: t.settings,
      sourceLabel: "Yours",
    }));
    return [...community, ...mine];
  }, [catalog, userTunes]);

  const track = useMemo(() => ({ ordinal: trackOrdinal, name: trackName, variant: trackVariant }), [trackOrdinal, trackName, trackVariant]);
  const matched = useMemo(() => rows.filter((t) => tuneMatchesTrack(t, track)), [rows, track]);

  const carOrdinals = useMemo(() => [...new Set(matched.map((t) => t.carOrdinal))], [matched]);
  const { data: names } = useResolveNames([], carOrdinals);
  const carName = (ordinal: number) => names?.carNames[String(ordinal)] ?? `Car ${ordinal}`;

  const uniqueCars = useMemo(() => [...new Set(matched.map((t) => t.carOrdinal))].sort((a, b) => carName(a).localeCompare(carName(b))), [matched, names]);

  const setups = useMemo(() => {
    let s = matched;
    if (filterCar) s = s.filter((t) => String(t.carOrdinal) === filterCar);
    return [...s].sort((a, b) => carName(a.carOrdinal).localeCompare(carName(b.carOrdinal)) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }, [matched, filterCar, names]);

  // Resolve / persist selection via the shared ?setup= url param.
  useEffect(() => {
    if (setups.length === 0) return;
    if (selectedId && setups.some((t) => t.id === selectedId)) return;
    const fromUrl = (search.setup ? setups.find((t) => t.id === search.setup) : undefined) ?? setups[0];
    setSelectedId(fromUrl.id);
  }, [setups, search.setup, selectedId]);

  const selectSetup = (id: string) => {
    setSelectedId(id);
    navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, setup: id })) as never, replace: true });
  };

  const selected = setups.find((t) => t.id === selectedId) ?? setups[0];

  if (setups.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm text-center px-4">No setups yet</div>;
  }

  return (
    <div className="flex gap-3 h-full overflow-hidden">
      {/* Left: filter + setup list */}
      <div className="w-[420px] shrink-0 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider shrink-0">Setups ({setups.length})</div>
          {uniqueCars.length > 1 && (
            <SearchSelect
              className="ml-auto w-48"
              value={filterCar}
              onChange={setFilterCar}
              placeholder="Search cars..."
              options={[{ value: "", label: "All cars" }, ...uniqueCars.map((o) => ({ value: String(o), label: carName(o) }))]}
            />
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-app-border/20">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt/50 border-b border-app-border/20 sticky top-0 z-10">
            <span className="text-[9px] text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
            <span className="text-[9px] text-app-text-dim uppercase flex-1">Name / Car</span>
            <span className="text-[9px] text-app-text-dim uppercase text-center">Cat</span>
          </div>
          {setups.map((t, i) => {
            const badge = CATEGORY_BADGE[t.category] ?? DEFAULT_BADGE;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => selectSetup(t.id)}
                className={`w-full text-left flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-b border-app-border/10 transition-colors ${
                  selected?.id === t.id ? "bg-app-accent/10" : "hover:bg-app-surface-alt/30"
                }`}
              >
                <span className="text-app-unit text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0 flex items-center gap-1">
                  <span className="text-app-unit font-medium text-app-text truncate">{t.name}</span>
                  <span className="text-[9px] text-app-text-dim truncate">({carName(t.carOrdinal)})</span>
                </div>
                <span className={`text-[8px] px-1 py-0.5 rounded font-bold shrink-0 ${badge.cls}`} title={t.category}>
                  {badge.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: setup detail */}
      {selected && (
        <div className="flex-1 min-w-0 overflow-y-auto space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-app-body font-bold text-app-text">{selected.name}</span>
            <span className="text-app-unit text-app-text-secondary">
              {carName(selected.carOrdinal)}
              {selected.sourceLabel && ` · ${selected.sourceLabel}`}
            </span>
          </div>
          {selected.description && <p className="text-xs text-app-text-dim">{selected.description}</p>}
          {gameId === "fm-2023" ? <ForzaSettingsGrid s={selected.settings as TuneSettings} /> : <SetupSettingsPanel gameId={gameId} settings={selected.settings as Record<string, unknown>} />}
        </div>
      )}
    </div>
  );
}
