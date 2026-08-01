import { useState } from "react";
import { useAddBase } from "../../hooks/queries";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { SetupFilePicker, type SetupFilePickerValue } from "./SetupFilePicker";

/**
 * "Add base" modal (design Phase 4) — reuses the extracted SetupFilePicker
 * to pick a car/track/setup from the Setups folder, then posts it as a new
 * root of the session's version forest via `POST /:id/bases`. Unlike
 * `NewExperimentModal` this doesn't create a session or name it — it just
 * adds a version node to the one already open.
 */
export function AddBaseModal({
  gameId,
  sessionId,
  lockedCar,
  onClose,
}: {
  gameId: "acc" | "ac-evo";
  sessionId: number;
  /** The session's car model slug — Add base is always for the same car (a base
   *  from another track), so the car is fixed and not pickable. */
  lockedCar?: string;
  onClose: () => void;
}) {
  const addBase = useAddBase();
  const [picked, setPicked] = useState<SetupFilePickerValue>({ car: lockedCar ?? "", track: "", setupPath: "" });
  const [label, setLabel] = useState("");
  const [setHead, setSetHead] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!picked.setupPath) return;
    setError(null);
    try {
      await addBase.mutateAsync({ sessionId, setupPath: picked.setupPath, label: label.trim() || undefined, setHead });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "Could not add base");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" showCloseButton={false} overlayClassName="bg-app-bg/60">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-app-text">Add base</DialogTitle>
          <DialogDescription className="text-xs text-app-text-dim">
            Pick a saved setup to start a second (or Nth) root in this session's version tree — an independent starting point alongside the existing versions, not a fork of any of them.
          </DialogDescription>
        </DialogHeader>
        <SetupFilePicker gameId={gameId} value={picked} onChange={setPicked} lockedCar={lockedCar} />

        <label className="flex flex-col gap-1">
          <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Label (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="base" maxLength={200} className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs" />
        </label>

        <label className="flex items-center gap-2 text-xs text-app-text-dim">
          <input type="checkbox" checked={setHead} onChange={(e) => setSetHead(e.target.checked)} />
          Switch to it as the current head
        </label>

        {error && <div className="text-xs text-status-danger">{error}</div>}

        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <Button variant="app-outline" size="app-sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="app-primary" size="app-sm" onClick={submit} disabled={addBase.isPending || !picked.setupPath} title={!picked.setupPath ? "Pick a setup file" : undefined}>
            {addBase.isPending ? "Adding…" : "Add base"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
