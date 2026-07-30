import { useMemo, useState } from "react";
import { useSetupFileContent, useSetupFiles } from "../../hooks/queries";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { SearchSelect } from "../ui/SearchSelect";

/** Read-only modal showing the picked setup file — human-readable sections
 *  when available, otherwise parsed JSON pretty-printed for ACC or decoded
 *  wire-tree text for AC Evo .carsetup files. */
/** Which tab a corner-section row belongs to, by its label. */
function rowTab(label: string): string {
  const l = label.toLowerCase();
  if (/(tyre|pressure|camber|toe|caster|compound)/.test(l)) return "Tyres";
  if (l.includes("bumpstop") || l.includes("packer")) return "Suspension"; // bump stops/packers live with springs in the ACE suspension screen
  if (/(bump|rebound|damper)/.test(l)) return "Dampers";
  return "Suspension";
}

/** Which tab a non-corner section belongs to, by its title. */
function sectionTab(title: string): string {
  const t = title.toLowerCase();
  if (t.startsWith("aero")) return "Aero";
  if (t.startsWith("electronics")) return "Electronics";
  if (t.startsWith("fuel")) return "Fuel & strategy";
  if (t.startsWith("mechanical") || t.startsWith("suspension") || t.startsWith("front") || t.startsWith("rear")) return "Suspension";
  return title;
}

const TAB_ORDER = ["Tyres", "Suspension", "Dampers", "Electronics", "Aero", "Fuel & strategy"];

export function SetupContentModal({ gameId, path, fileName, onClose }: { gameId: "acc" | "ac-evo"; path: string; fileName: string; onClose: () => void }) {
  const { data, isLoading, error } = useSetupFileContent(gameId, path);
  const sections = data?.sections?.length ? data.sections : null;
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const body = data?.formatted ?? (data?.setup ? JSON.stringify(data.setup, null, 2) : null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="@container/setup-file flex h-[60vh] w-[min(94vw,720px)] max-w-[720px] flex-col">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="truncate">{data?.fileName ?? fileName}</DialogTitle>
          {data?.presetId && <DialogDescription className="truncate text-app-compact">Preset {data.presetId}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {(error || data?.error) && <div className="text-sm text-status-danger">{data?.error ?? "Couldn't read the setup file."}</div>}
          {sections && (
            <div className="space-y-4">
              {/* Tabbed view: corner sections (FL/FR/RL/RR) mix tyre, suspension
                  and damper rows, so their rows are split per-tab; every other
                  section maps to a whole tab. Corner cards keep the aligned 2x2
                  grid (FL/FR over RL/RR); other sections flow in masonry. */}
              {(() => {
                const CORNER_ORDER = ["Front left", "Front right", "Rear left", "Rear right"];
                const allCorners = [...sections].filter((s) => CORNER_ORDER.includes(s.title)).sort((a, b) => CORNER_ORDER.indexOf(a.title) - CORNER_ORDER.indexOf(b.title));
                const allOthers = sections.filter((s) => !CORNER_ORDER.includes(s.title));
                const tabs: string[] = [];
                const seen = new Set<string>();
                const push = (t: string) => {
                  if (!seen.has(t)) {
                    seen.add(t);
                    tabs.push(t);
                  }
                };
                for (const s of allCorners) for (const r of s.rows) push(rowTab(r.label));
                for (const s of allOthers) push(sectionTab(s.title));
                tabs.sort((a, b) => {
                  const ia = TAB_ORDER.indexOf(a);
                  const ib = TAB_ORDER.indexOf(b);
                  return (ia === -1 ? TAB_ORDER.length : ia) - (ib === -1 ? TAB_ORDER.length : ib);
                });
                const tab = activeTab && tabs.includes(activeTab) ? activeTab : tabs[0];
                const corners = allCorners.map((s) => ({ ...s, rows: s.rows.filter((r) => rowTab(r.label) === tab) })).filter((s) => s.rows.length > 0);
                const others = allOthers.filter((s) => sectionTab(s.title) === tab);
                const card = (s: (typeof sections)[number], masonry: boolean) => (
                  <div key={s.title} className={`${masonry ? "mb-3 break-inside-avoid " : ""}rounded-lg bg-app-bg p-3`}>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-accent">{s.title}</h4>
                    <div className="space-y-0.5">
                      {s.rows.map((r) => (
                        <div key={r.label} className={`text-xs${r.fixed ? " opacity-45" : ""}`} title={r.fixed ? "Fixed for this car — not adjustable in the in-game tune menu" : undefined}>
                          <div className="flex justify-between gap-2">
                            <span className="whitespace-nowrap text-app-text-muted">{r.label}</span>
                            <span className="whitespace-nowrap font-mono text-app-text">{r.value}</span>
                          </div>
                          {/* Range bar (like the AI analysis result) — only for rows
                              with a real extracted per-car min/max from the server. */}
                          {r.num != null && r.min != null && r.max != null && r.max > r.min && (
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-app-caption font-mono tabular-nums text-muted-foreground">{r.min}</span>
                              <div className="relative h-1 flex-1 rounded bg-muted">
                                <span
                                  className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded bg-(--focus-setup)"
                                  style={{ left: `${Math.min(100, Math.max(0, ((r.num - r.min) / (r.max - r.min)) * 100))}%` }}
                                />
                              </div>
                              <span className="text-app-caption font-mono tabular-nums text-muted-foreground">{r.max}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
                return (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-1 border-b border-app-border pb-2">
                      {tabs.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setActiveTab(t)}
                          className={`rounded px-2 py-1 text-app-compact ${t === tab ? "bg-app-bg font-semibold text-app-accent" : "text-app-text-muted hover:text-app-text"}`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    {tab === "Aero" && others.length > 0 ? (
                      // Aero: rear fields on the left, front fields on the right.
                      <div className="grid grid-cols-1 gap-3 @3xl/setup-file:grid-cols-2">
                        {(() => {
                          const rows = others.flatMap((s) => s.rows);
                          const rear = rows.filter((r) => /rear|wing/i.test(r.label));
                          const front = rows.filter((r) => !/rear|wing/i.test(r.label));
                          return [card({ title: "Rear", rows: rear }, false), card({ title: "Front", rows: front }, false)];
                        })()}
                      </div>
                    ) : tab === "Suspension" ? (
                      // Suspension: front card above the FL/FR/RL/RR grid, rear card below.
                      <div className="flex flex-col gap-3">
                        {(() => {
                          const rear = others.filter((s) => /rear/i.test(s.title));
                          const front = others.filter((s) => !/rear/i.test(s.title));
                          return (
                            <>
                              {front.map((s) => card(s, false))}
                              {corners.length > 0 && <div className="grid grid-cols-1 content-start gap-3 @3xl/setup-file:grid-cols-2">{corners.map((s) => card(s, false))}</div>}
                              {rear.map((s) => card(s, false))}
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 @5xl/setup-file:flex-row @5xl/setup-file:items-start">
                        {corners.length > 0 && (
                          <div className="grid shrink-0 grid-cols-1 content-start gap-3 @3xl/setup-file:grid-cols-2 @5xl/setup-file:w-1/2">{corners.map((s) => card(s, false))}</div>
                        )}
                        {others.length > 0 && <div className="w-full min-w-0 columns-1 gap-3 @3xl/setup-file:columns-2">{others.map((s) => card(s, true))}</div>}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          {!sections && body && <pre className="text-app-label leading-relaxed whitespace-pre-wrap font-mono">{body}</pre>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface SetupFilePickerValue {
  car: string;
  track: string;
  setupPath: string;
}

/**
 * Cascading car → track → setup file picker, extracted from
 * `NewExperimentModal` (design doc cross-cutting cleanup #2) so it can be
 * reused wherever a driver needs to pick an existing Setups-folder file
 * without dragging in session-creation-only logic (drag/drop-to-place, name
 * defaulting, etc). Reused by the "Add base" modal (Phase 4).
 *
 * Controlled: the caller owns `value` and clears the deeper fields itself
 * when a shallower one changes (car change clears track+setup, track change
 * clears setup) via `onChange`.
 */
export function SetupFilePicker({
  gameId,
  value,
  onChange,
  lockedCar,
  labels = { car: "Car", track: "Track", setup: "Base setup" },
}: {
  gameId: "acc" | "ac-evo";
  value: SetupFilePickerValue;
  onChange: (value: SetupFilePickerValue) => void;
  /** When set, the car is fixed to this model slug and shown read-only — only
   *  track + setup are pickable (e.g. Add base: same car, another track). */
  lockedCar?: string;
  labels?: { car?: string; track?: string; setup?: string };
}) {
  const { data: setupFiles, isLoading: loadingFiles, refetch, isFetching } = useSetupFiles(gameId);
  const files = setupFiles?.files ?? [];

  // Friendly car label per model slug, from the canonical cars.csv roster.
  const carNameByModel = useMemo(() => new Map((setupFiles?.cars ?? []).map((c) => [c.model, c.name] as const)), [setupFiles]);

  // Car options = full canonical roster unioned with any model that already has
  // a saved setup (catches slugs missing from the CSV). Labelled with the
  // friendly name; the value stays the model slug the session is keyed on.
  const cars = useMemo(() => {
    const models = new Set<string>([...(setupFiles?.cars ?? []).map((c) => c.model), ...files.map((f) => f.carModel)]);
    // Setup count per car — cars with no saved setup are shown but disabled,
    // since a session needs a base setup file to start from.
    const countByCar = new Map<string, number>();
    for (const f of files) countByCar.set(f.carModel, (countByCar.get(f.carModel) ?? 0) + 1);
    return [...models]
      .map((model) => {
        const name = carNameByModel.get(model) ?? model;
        const n = countByCar.get(model) ?? 0;
        return { value: model, label: n ? `${name} (${n})` : name, disabled: n === 0 };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [setupFiles, files, carNameByModel]);
  const noCars = !loadingFiles && cars.length === 0;

  // AC Evo saves setups per circuit, not per layout — variants of one track
  // (Brands Hatch GP + Indy) share a single on-disk Setups folder, so an Indy
  // session must also see files saved under the shared/base folder. The server
  // sends the alias group per track key (derived from tracks.csv base names);
  // fold each key + its aliases into one normalised matcher.
  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const aliasesFor = (track: string): Set<string> => {
    const set = new Set<string>([norm(track)]);
    for (const a of setupFiles?.trackAliases?.[track] ?? []) set.add(norm(a));
    return set;
  };
  // Track options = full canonical track roster, plus on-disk folders the chosen
  // car has setups under ONLY when no canonical key (or one of its aliases)
  // already covers that folder — so the raw folder name ("Brands Hatch") never
  // shows next to its friendly variant rows, only truly unknown folders do.
  const tracks = useMemo(() => {
    const canonical = setupFiles?.tracks ?? [];
    const covered = new Set<string>();
    for (const key of canonical) for (const a of aliasesFor(key)) covered.add(a);
    const extras = files.filter((f) => f.carModel === value.car && !covered.has(norm(f.trackName))).map((f) => f.trackName);
    return [...new Set([...canonical, ...extras])].sort();
  }, [setupFiles, files, value.car]);
  const carTrackFiles = useMemo(() => {
    const wanted = aliasesFor(value.track);
    return files.filter((f) => f.carModel === value.car && wanted.has(norm(f.trackName)));
  }, [files, setupFiles, value.car, value.track]);
  // Saved-setup count per track for the current car — shown against each track
  // so the driver sees where they already have bases (e.g. "Barcelona (3)").
  // Counted through the same alias groups so variant rows reflect the shared folder.
  const countByTrack = useMemo(() => {
    const byFolder = new Map<string, number>();
    for (const f of files)
      if (f.carModel === value.car) {
        const k = norm(f.trackName);
        byFolder.set(k, (byFolder.get(k) ?? 0) + 1);
      }
    const m = new Map<string, number>();
    const keys = new Set<string>([...(setupFiles?.tracks ?? []), ...files.map((f) => f.trackName)]);
    for (const key of keys) {
      let n = 0;
      for (const a of aliasesFor(key)) n += byFolder.get(a) ?? 0;
      if (n) m.set(key, n);
    }
    return m;
  }, [files, setupFiles, value.car]);

  return (
    <div className="grid grid-cols-1 gap-3">
      {!lockedCar && (
        <div className="flex flex-col gap-1">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{labels.car ?? "Car"}</span>
          <SearchSelect
            value={value.car}
            onChange={(v) => onChange({ car: v, track: "", setupPath: "" })}
            options={cars}
            placeholder={loadingFiles ? "Loading…" : noCars ? "No cars" : "Search cars…"}
            disabled={loadingFiles || noCars}
            focusColor="purple-500"
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{labels.track ?? "Track"}</span>
        <SearchSelect
          value={value.track}
          onChange={(v) => onChange({ ...value, track: v, setupPath: "" })}
          options={tracks.map((t) => {
            const name = setupFiles?.trackNames?.[t] ?? t;
            const n = countByTrack.get(t) ?? 0;
            return { value: t, label: n ? `${name} (${n})` : name, disabled: n === 0 };
          })}
          placeholder={!value.car ? "Pick a car first" : "Search tracks…"}
          disabled={!value.car}
          focusColor="purple-500"
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{labels.setup ?? "Base setup"}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              title="Rescan the Setups folder for new files"
              className="text-app-compact text-app-text-muted hover:text-app-text disabled:opacity-50 flex items-center gap-1"
            >
              <span className={isFetching ? "animate-spin inline-block" : "inline-block"}>⟳</span>
              Refresh
            </button>
          </div>
        </div>
        <SearchSelect
          value={value.setupPath}
          onChange={(v) => onChange({ ...value, setupPath: v })}
          options={carTrackFiles.map((f) => ({ value: f.absolutePath, label: f.fileName }))}
          placeholder={!value.car || !value.track ? "Pick car + track" : "Search setups…"}
          disabled={!value.car || !value.track}
          focusColor="purple-500"
        />
      </div>
    </div>
  );
}
