import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus } from "@shared/racing/experiments/focus";
import { useEffect, useMemo, useState } from "react";
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
          <DialogTitle className="truncate text-sm font-semibold">New experiment</DialogTitle>
        </DialogHeader>

        <FocusPicker value={focus} onChange={setFocus} />

        {focus === "car" && (
          <p className="text-app-compact text-app-text-dim">F1 setups are read from telemetry — your base setup will be captured from your first lap, or via "Capture current setup" in the session.</p>
        )}

        <div className="flex gap-2">
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Car (optional)</span>
            <input value={car} onChange={(e) => setCar(e.target.value)} placeholder="Car name" maxLength={200} className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs" />
          </label>
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Track</span>
            <SearchSelect value={track} onChange={setTrack} options={trackOptions} placeholder="Search tracks…" focusColor="purple-500" />
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Session name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={car && track ? `${car} @ ${track}` : "Session name"}
            maxLength={120}
            className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          />
        </label>

        {error && <div className="text-xs text-status-danger">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="app-outline" size="app-md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="app-primary" size="app-md" onClick={submit} disabled={create.isPending || !canCreate} title={!canCreate ? "Pick a track" : undefined}>
            {create.isPending ? "Creating…" : "Create session"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
