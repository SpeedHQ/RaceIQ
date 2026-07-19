import { createPortal } from "react-dom";
import { useState } from "react";
import { useAddBase } from "../../hooks/queries";
import { SetupFilePicker, type SetupFilePickerValue } from "./SetupFilePicker";

/**
 * "Add base" modal (design Phase 4) — reuses the extracted SetupFilePicker
 * to pick a car/track/setup from the Setups folder, then posts it as a new
 * root of the session's version forest via `POST /:id/bases`. Unlike
 * `NewTuningSessionModal` this doesn't create a session or name it — it just
 * adds a version node to the one already open.
 */
export function AddBaseModal({
  gameId,
  sessionId,
  onClose,
}: {
  gameId: "acc" | "ac-evo";
  sessionId: number;
  onClose: () => void;
}) {
  const addBase = useAddBase();
  const [picked, setPicked] = useState<SetupFilePickerValue>({ car: "", track: "", setupPath: "" });
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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[680px] max-w-[94vw] flex flex-col gap-4 p-5"
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-app-text">Add base</p>
          <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-app-text-dim -mt-2">
          Pick a saved setup to start a second (or Nth) root in this session's version tree — an independent
          starting point alongside the existing versions, not a fork of any of them.
        </p>

        <SetupFilePicker gameId={gameId} value={picked} onChange={setPicked} />

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-app-text-muted uppercase tracking-wider">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="base"
            maxLength={200}
            className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          />
        </label>

        <label className="flex items-center gap-2 text-xs text-app-text-dim">
          <input type="checkbox" checked={setHead} onChange={(e) => setSetHead(e.target.checked)} />
          Switch to it as the current head
        </label>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-app-border text-app-text-dim hover:text-app-text">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={addBase.isPending || !picked.setupPath}
            title={!picked.setupPath ? "Pick a setup file" : undefined}
            className="px-3 py-1.5 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-semibold"
          >
            {addBase.isPending ? "Adding…" : "Add base"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
