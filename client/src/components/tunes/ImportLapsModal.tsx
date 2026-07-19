import { createPortal } from "react-dom";
import { useMemo, useState } from "react";
import { useImportableLaps, useImportLaps, type TuningTest } from "../../hooks/queries";
import type { GameId, LapMeta } from "@shared/types";

function fmtLapTime(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

/**
 * "Add laps from history" modal (design Phase 6, Mode B / collect) — lists
 * laps matching this session's game/car/track that aren't stamped to any
 * tuning session yet, lets the user multiselect a batch and pick a target
 * (a specific branch/version, or the session baseline), then posts them via
 * `POST /:id/import-laps`.
 *
 * The setup-consistency warning only applies to ACC/AC-Evo: those laps carry
 * whatever setup was on disk when they were driven, which may not match the
 * target version's setup file, so we surface a generic caution banner. F1
 * laps carry a structured `carSetup` snapshot that could in principle be
 * diffed against a target `tuningTests.setupSnapshot` for a precise
 * match/mismatch readout — but the F1 tuning workspace itself isn't wired up
 * yet (design Phase 10), so the banner is simply suppressed for F1 here
 * rather than showing a check that has no live UI to act on.
 */
export function ImportLapsModal({
  gameId,
  sessionId,
  tests,
  onClose,
}: {
  gameId: GameId;
  sessionId: number;
  tests: TuningTest[];
  onClose: () => void;
}) {
  const { data: importable, isLoading } = useImportableLaps(sessionId);
  const importLaps = useImportLaps();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targetTestId, setTargetTestId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const laps = useMemo(() => importable ?? [], [importable]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === laps.length ? new Set() : new Set(laps.map((l: LapMeta) => l.id))));
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setError(null);
    try {
      await importLaps.mutateAsync({
        sessionId,
        lapIds: Array.from(selected),
        tuningTestId: targetTestId ? Number(targetTestId) : null,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "Could not import laps");
    }
  };

  const showSetupWarning = (gameId === "acc" || gameId === "ac-evo") && selected.size > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[720px] max-w-[94vw] max-h-[86vh] flex flex-col gap-4 p-5"
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-app-text">Add laps from history</p>
          <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-app-text-dim -mt-2">
          Attach laps already recorded for this car and track to this session, instead of driving fresh ones.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-app-text-muted uppercase tracking-wider">Attach to</span>
          <select
            value={targetTestId}
            onChange={(e) => setTargetTestId(e.target.value)}
            className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          >
            <option value="">Session baseline (no specific version)</option>
            {tests.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} (v{t.version})
              </option>
            ))}
          </select>
        </label>

        {showSetupWarning && (
          <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-900/60 rounded px-3 py-2">
            These laps were driven under whatever setup was saved at the time, which may not match the target
            version's setup file. Review them for consistency before relying on them for tuning advice.
          </div>
        )}

        <div className="flex items-center justify-between text-[11px] text-app-text-muted uppercase tracking-wider">
          <span>Importable laps ({laps.length})</span>
          {laps.length > 0 && (
            <button type="button" onClick={toggleAll} className="normal-case text-app-text-dim hover:text-app-text">
              {selected.size === laps.length ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>

        <div className="flex-1 min-h-[120px] overflow-y-auto border border-app-border rounded divide-y divide-app-border">
          {isLoading && <div className="text-xs text-app-text-dim p-3">Loading…</div>}
          {!isLoading && laps.length === 0 && (
            <div className="text-xs text-app-text-dim p-3">No unattached laps match this session's car and track.</div>
          )}
          {laps.map((lap: LapMeta) => (
            <label
              key={lap.id}
              className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-app-bg/60"
            >
              <input type="checkbox" checked={selected.has(lap.id)} onChange={() => toggle(lap.id)} />
              <span className="text-app-text tabular-nums">{fmtLapTime(lap.lapTime)}</span>
              <span className="text-app-text-dim">{lap.isValid ? "Valid" : "Invalid"}</span>
              {lap.tuneName && <span className="text-app-text-dim truncate">{lap.tuneName}</span>}
              <span className="ml-auto text-app-text-muted">{new Date(lap.createdAt).toLocaleString()}</span>
            </label>
          ))}
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-app-border text-app-text-dim hover:text-app-text">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={importLaps.isPending || selected.size === 0}
            title={selected.size === 0 ? "Select at least one lap" : undefined}
            className="px-3 py-1.5 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-semibold"
          >
            {importLaps.isPending ? "Importing…" : `Import ${selected.size || ""} lap${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
