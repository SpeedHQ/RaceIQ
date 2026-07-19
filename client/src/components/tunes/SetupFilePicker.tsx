import { useMemo } from "react";
import { SearchSelect } from "../ui/SearchSelect";
import { useSetupFiles } from "../../hooks/queries";

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
  labels = { car: "Car", track: "Track", setup: "Base setup" },
}: {
  gameId: "acc" | "ac-evo";
  value: SetupFilePickerValue;
  onChange: (value: SetupFilePickerValue) => void;
  labels?: { car?: string; track?: string; setup?: string };
}) {
  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
  const files = setupFiles?.files ?? [];
  const noFiles = !loadingFiles && files.length === 0;

  const cars = useMemo(() => [...new Set(files.map((f) => f.carModel))].sort(), [files]);
  const tracks = useMemo(
    () => [...new Set(files.filter((f) => f.carModel === value.car).map((f) => f.trackName))].sort(),
    [files, value.car],
  );
  const carTrackFiles = useMemo(
    () => files.filter((f) => f.carModel === value.car && f.trackName === value.track),
    [files, value.car, value.track],
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.car ?? "Car"}</span>
        <SearchSelect
          value={value.car}
          onChange={(v) => onChange({ car: v, track: "", setupPath: "" })}
          options={cars.map((c) => ({ value: c, label: c }))}
          placeholder={loadingFiles ? "Loading…" : noFiles ? "No saved setups" : "Search cars…"}
          disabled={loadingFiles || noFiles}
          focusColor="purple-500"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.track ?? "Track"}</span>
        <SearchSelect
          value={value.track}
          onChange={(v) => onChange({ ...value, track: v, setupPath: "" })}
          options={tracks.map((t) => ({ value: t, label: t }))}
          placeholder={!value.car ? "Pick a car first" : "Search tracks…"}
          disabled={!value.car}
          focusColor="purple-500"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-app-text-muted uppercase tracking-wider">{labels.setup ?? "Base setup"}</span>
        <SearchSelect
          value={value.setupPath}
          onChange={(v) => onChange({ ...value, setupPath: v })}
          options={carTrackFiles.map((f) => ({ value: f.absolutePath, label: f.fileName }))}
          placeholder={!value.car || !value.track ? "Pick car + track" : "Search setups…"}
          disabled={!value.car || !value.track}
          focusColor="purple-500"
        />
      </label>
    </div>
  );
}
