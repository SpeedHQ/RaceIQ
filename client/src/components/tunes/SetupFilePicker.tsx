import { useMemo, useState } from "react";
import { useSetupFileContent, useSetupFiles } from "../../hooks/queries";
import { SearchSelect } from "../ui/SearchSelect";

/** Read-only modal showing the picked setup file — parsed JSON pretty-printed
 *  for ACC, decoded wire-tree text for AC Evo .carsetup files. */
function SetupContentModal({ gameId, path, fileName, onClose }: { gameId: "acc" | "ac-evo"; path: string; fileName: string; onClose: () => void }) {
  const { data, isLoading, error } = useSetupFileContent(gameId, path);
  const body = data?.formatted ?? (data?.setup ? JSON.stringify(data.setup, null, 2) : null);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[min(90vw,640px)] max-h-[80vh] flex flex-col"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="min-w-0">
            <div className="text-sm font-medium text-app-text truncate">{data?.fileName ?? fileName}</div>
            {data?.presetId && <div className="text-[11px] text-app-text-muted truncate">Preset {data.presetId}</div>}
          </div>
          <button type="button" onClick={onClose} className="text-app-text-muted hover:text-app-text text-lg leading-none px-1" aria-label="Close">
            ×
          </button>
        </div>
        <div className="overflow-auto px-4 py-3">
          {isLoading && <div className="text-sm text-app-text-muted">Loading…</div>}
          {(error || data?.error) && <div className="text-sm text-red-400">{data?.error ?? "Couldn't read the setup file."}</div>}
          {body && <pre className="text-[12px] leading-relaxed text-app-text whitespace-pre-wrap font-mono">{body}</pre>}
        </div>
      </div>
    </div>
  );
}

export interface SetupFilePickerValue {
  car: string;
  track: string;
  setupPath: string;
}

/**
 * Cascading car → track → setup file picker, extracted from
 * `NewTuningSessionModal` (design doc cross-cutting cleanup #2) so it can be
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
  const [viewOpen, setViewOpen] = useState(false);
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

  // Track options = full canonical track roster unioned with tracks the chosen
  // car already has setups for, so any track is selectable even without a base.
  const tracks = useMemo(() => [...new Set([...(setupFiles?.tracks ?? []), ...files.filter((f) => f.carModel === value.car).map((f) => f.trackName)])].sort(), [setupFiles, files, value.car]);
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
          <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.car ?? "Car"}</span>
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
        <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.track ?? "Track"}</span>
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
          <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.setup ?? "Base setup"}</span>
          <div className="flex items-center gap-3">
            {value.setupPath && (
              <button
                type="button"
                onClick={() => setViewOpen(true)}
                title="View the contents of the selected setup file"
                className="text-[11px] text-app-text-muted hover:text-app-text flex items-center gap-1"
              >
                View tune
              </button>
            )}
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              title="Rescan the Setups folder for new files"
              className="text-[11px] text-app-text-muted hover:text-app-text disabled:opacity-50 flex items-center gap-1"
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
      {viewOpen && value.setupPath && (
        <SetupContentModal gameId={gameId} path={value.setupPath} fileName={carTrackFiles.find((f) => f.absolutePath === value.setupPath)?.fileName ?? "Setup"} onClose={() => setViewOpen(false)} />
      )}
    </div>
  );
}
