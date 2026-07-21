import { useMemo } from "react";
import { useSetupFiles } from "../../hooks/queries";
import { SearchSelect } from "../ui/SearchSelect";

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
  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
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
  const carTrackFiles = useMemo(() => files.filter((f) => f.carModel === value.car && f.trackName === value.track), [files, value.car, value.track]);
  // Saved-setup count per track for the current car — shown against each track
  // so the driver sees where they already have bases (e.g. "Barcelona (3)").
  const countByTrack = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files) if (f.carModel === value.car) m.set(f.trackName, (m.get(f.trackName) ?? 0) + 1);
    return m;
  }, [files, value.car]);

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
        <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.setup ?? "Base setup"}</span>
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
