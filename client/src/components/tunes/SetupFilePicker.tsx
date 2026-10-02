import { useMemo } from "react";
import { m } from "@/paraglide/messages";
import { useSetupFileContent, useSetupFiles } from "../../hooks/setup-queries";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { SearchSelect } from "../ui/SearchSelect";
import { SetupSections } from "./SetupSections";


/** Read-only modal showing the picked setup file — human-readable sections
 *  when available, otherwise parsed JSON pretty-printed for ACC or decoded
 *  wire-tree text for AC Evo .carsetup files. */


export function SetupContentModal({ gameId, path, fileName, onClose }: { gameId: "acc" | "ac-evo"; path: string; fileName: string; onClose: () => void }) {
  const { data, isLoading, error } = useSetupFileContent(gameId, path);
  const sections = data?.sections?.length ? data.sections : null;
  const body = data?.formatted ?? (data?.setup ? JSON.stringify(data.setup, null, 2) : null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* Composition-only sizing/layout keeps picker viewport scrollable; DialogContent owns surface, border, and radius. */}
      <DialogContent size="lg" className="@container/setup-file flex h-[60vh] w-[min(94vw,720px)] max-w-[720px] flex-col">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="truncate">{data?.fileName ?? fileName}</DialogTitle>
          {data?.presetId && <DialogDescription className="truncate">Preset {data.presetId}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading && <div className="text-sm text-muted-foreground">{m.common_loading()}</div>}
          {(error || data?.error) && <div className="text-sm text-status-danger">{data?.error ?? m.experiment_setup_read_error()}</div>}
          {sections && <SetupSections sections={sections} />}
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
  labels = { car: m.label_car(), track: m.label_track(), setup: m.experiment_base_setup() },
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
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{labels.car ?? m.label_car()}</span>
          <SearchSelect
            value={value.car}
            onChange={(v) => onChange({ car: v, track: "", setupPath: "" })}
            options={cars}
            placeholder={loadingFiles ? m.common_loading() : noCars ? m.experiment_no_cars() : m.experiment_search_cars()}
            disabled={loadingFiles || noCars}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{labels.track ?? m.label_track()}</span>
        <SearchSelect
          value={value.track}
          onChange={(v) => onChange({ ...value, track: v, setupPath: "" })}
          options={tracks.map((t) => {
            const name = setupFiles?.trackNames?.[t] ?? t;
            const n = countByTrack.get(t) ?? 0;
            return { value: t, label: n ? `${name} (${n})` : name, disabled: n === 0 };
          })}
          placeholder={!value.car ? m.experiment_pick_car_first() : m.experiment_search_tracks()}
          disabled={!value.car}
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{labels.setup ?? m.experiment_base_setup()}</span>
          <div className="flex items-center gap-3">
            <Button
              variant="app-ghost"
              size="app-sm"
              onClick={() => refetch()}
              disabled={isFetching}
              title={m.experiment_rescan_setups()}
              className="text-app-compact text-app-text-muted hover:text-app-text"
            >
              <span className={isFetching ? "inline-block animate-spin" : "inline-block"}>⟳</span>
              {m.experiment_refresh()}
            </Button>
          </div>
        </div>
        <SearchSelect
          value={value.setupPath}
          onChange={(v) => onChange({ ...value, setupPath: v })}
          options={carTrackFiles.map((f) => ({ value: f.absolutePath, label: f.fileName }))}
          placeholder={!value.car || !value.track ? m.experiment_pick_car_track() : m.experiment_search_setups()}
          disabled={!value.car || !value.track}
        />
      </div>
    </div>
  );
}
