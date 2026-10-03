import { m } from "@/paraglide/messages";
import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus } from "@raceiq/shared/racing/experiments/focus";
import { useEffect, useMemo, useState } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { FocusPicker } from "@/components/tunes/FocusPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { useResolveNames, useTracks } from "@/hooks/catalog-queries";
import { useCreateExperiment } from "@/hooks/experiments";
import { useTelemetryStore } from "@/stores/telemetry";

export function NewF1ExperimentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const view = useTelemetryStore((s) => s.telemetryView);
  const trackOrdinal = view?.identity.trackOrdinal;
  const carOrdinal = view?.identity.carOrdinal;
  const { data: names } = useResolveNames(trackOrdinal != null ? [trackOrdinal] : [], carOrdinal != null ? [carOrdinal] : []);
  const liveCar = carOrdinal != null ? (names?.carNames[String(carOrdinal)] ?? "") : "";
  const liveTrack = trackOrdinal != null ? (names?.trackNames[String(trackOrdinal)] ?? "") : "";

  const { data: tracksData } = useTracks();

  const trackOptions = useMemo(() => {
    const list = (tracksData as { ordinal: number; name: string }[] | undefined) ?? [];
    return [...new Set(list.map((t) => t.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
  }, [tracksData]);

  const create = useCreateExperiment();
  const [name, setName] = useState("");
  const [car, setCar] = useState(liveCar);
  const [track, setTrack] = useState("");
  const [trackAutoSet, setTrackAutoSet] = useState(false);
  // Same choice every game offers — focus belongs to the experiment, not to a
  // game's setup format.
  const [focus, setFocus] = useState<ExperimentFocus>(DEFAULT_EXPERIMENT_FOCUS);
  const [error, setError] = useState<string | null>(null);

  // trackOptions may be empty on first render (query not resolved yet), so we
  // can't reliably prefill from the useState initializer — wait for the
  // options to load, then prefill once from the live packet's track, only if
  // the driver hasn't already picked one themselves.
  useEffect(() => {
    if (!trackAutoSet && !track && liveTrack && trackOptions.some((o) => o.value === liveTrack)) {
      setTrackAutoSet(true);
      setTrack(liveTrack);
    }
  }, [trackAutoSet, track, liveTrack, trackOptions]);

  const effectiveName = name.trim() || (track ? (car ? `${car} @ ${track}` : track) : "");
  const canCreate = !!effectiveName && !!track.trim();

  const submit = async () => {
    if (!canCreate) return;
    setError(null);
    try {
      const s = await create.mutateAsync({
        gameId: "f1-2025",
        name: effectiveName,
        carName: car.trim() || null,
        trackName: track.trim() || null,
        baseSetupPath: null,
        focus,
      });
      onCreated(s.id);
    } catch (err: any) {
      setError(err?.message ?? "Could not create experiment");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" layout="scrollable" className="flex w-[480px] max-w-[94vw] flex-col">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="truncate text-sm font-semibold">{m.experiment_new_title()}</DialogTitle>
        </DialogHeader>

        <FocusPicker value={focus} onChange={setFocus} />

        {focus === "car" && (
          <p className="text-app-compact text-app-text-dim">{m.experiment_f1_setup_note()}</p>
        )}

        <div className="flex gap-2">
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{m.experiment_car_optional()}</span>
            <AppInput value={car} onChange={(e) => setCar(e.target.value)} placeholder={m.experiment_car_name_placeholder()} maxLength={200} className="text-xs" />
          </label>
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{m.label_track()}</span>
            <SearchSelect value={track} onChange={setTrack} options={trackOptions} placeholder={m.experiment_search_tracks()} />
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{m.experiment_session_name()}</span>
          <AppInput value={name} onChange={(e) => setName(e.target.value)} placeholder={car && track ? `${car} @ ${track}` : m.experiment_session_name()} maxLength={120} className="text-xs" />
        </label>

        {error && <div className="text-xs text-status-danger">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="app-outline" size="app-md" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button variant="app-primary" size="app-md" onClick={submit} disabled={create.isPending || !canCreate} title={!canCreate ? m.experiment_pick_track() : undefined}>
            {create.isPending ? m.experiment_creating() : m.experiment_create_session()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
