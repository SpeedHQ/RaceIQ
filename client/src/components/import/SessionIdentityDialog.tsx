import { useEffect, useMemo, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import { useCarsForGame, useTracksForGame } from "../../hooks/catalog-queries";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { SearchSelect } from "../ui/SearchSelect";
export interface SessionIdentity {
  carId: string;
  trackId: string;
}

export interface SessionIdentityDialogProps {
  gameId: GameId;
  initialCarId?: string | null;
  initialTrackId?: string | null;
  onSave: (identity: SessionIdentity) => Promise<void>;
  onClose: () => void;
}

export function SessionIdentityDialog({ gameId, initialCarId, initialTrackId, onSave, onClose }: SessionIdentityDialogProps) {
  const { data: tracks, isLoading: tracksLoading, isError: tracksError, refetch: refetchTracks } = useTracksForGame(gameId);
  const { data: cars, isLoading: carsLoading, isError: carsError, refetch: refetchCars } = useCarsForGame(gameId);
  const trackOptions = useMemo(() => (tracks ?? []).map((track) => ({ value: String(track.id), label: track.variant ? `${track.name} — ${track.variant}` : track.name })), [tracks]);
  const carOptions = useMemo(() => (cars ?? []).map((car) => ({ value: String(car.id), label: car.name })), [cars]);
  const [carId, setCarId] = useState("");
  const [trackId, setTrackId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (cars) setCarId((current) => cars.some((car) => String(car.id) === current) ? current : cars.some((car) => String(car.id) === initialCarId) ? initialCarId! : "");
  }, [cars, initialCarId]);
  useEffect(() => {
    if (tracks) setTrackId((current) => tracks.some((track) => String(track.id) === current) ? current : tracks.some((track) => String(track.id) === initialTrackId) ? initialTrackId! : "");
  }, [tracks, initialTrackId]);
  const identityKey = `${gameId}:${initialCarId ?? ""}:${initialTrackId ?? ""}`;
  const [selectionKey, setSelectionKey] = useState(identityKey);
  if (selectionKey !== identityKey) {
    setSelectionKey(identityKey);
    setCarId("");
    setTrackId("");
  }
  async function save() {
    if (!carOptions.some((option) => option.value === carId) || !trackOptions.some((option) => option.value === trackId)) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ carId, trackId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save session identity.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader><DialogTitle>Assign session car and track</DialogTitle></DialogHeader>
        {carsLoading || tracksLoading ? <p className="text-app-text-muted">Loading catalog…</p> : (
          <div className="grid gap-3">
            {carsError || tracksError ? <div role="alert" className="text-app-danger">
              <p>Could not load game catalog.</p>
              <Button variant="ghost" onClick={() => { void refetchCars(); void refetchTracks(); }}>Retry</Button>
            </div> : <>
              <label className="grid gap-1 text-app-text-dim">Car<SearchSelect value={carId} onChange={setCarId} options={carOptions} placeholder="Search cars" /></label>
              <label className="grid gap-1 text-app-text-dim">Track<SearchSelect value={trackId} onChange={setTrackId} options={trackOptions} placeholder="Search tracks" /></label>
            </>}
          </div>
        )}
        {error && <p role="alert" className="text-app-danger">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} disabled={carsLoading || tracksLoading || carsError || tracksError || saving || !carOptions.some((option) => option.value === carId) || !trackOptions.some((option) => option.value === trackId)}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
