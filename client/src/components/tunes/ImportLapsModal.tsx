import type { GameId } from "@shared/types";
import { useMemo, useState } from "react";
import { type ImportableLap, type ExperimentVersion, useImportableLaps, useImportLaps } from "../../hooks/queries";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

function fmtLapTime(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

const UNKNOWN_SETUP_KEY = "__unknown__";

/**
 * "Add laps from history" modal (design Phase 6, Mode B / collect) — lists
 * laps matching this session's game/car/track that aren't stamped to any
 * experiment yet, lets the user multiselect a batch, then posts them via
 * `POST /:id/import-laps`.
 *
 * F1 laps each carry their own in-car setup, so there's no manual target
 * picker for F1: the server auto-sorts the batch into setups (matching
 * fingerprints merge into the same version, new ones become new versions).
 * The modal instead offers a "group by setup" view driven by the
 * `setupFingerprint`/`setupSummary` fields the server attaches per lap.
 *
 * ACC/AC-Evo laps carry whatever setup was on disk when they were driven,
 * which may not match the target version's setup file, so those keep the
 * manual target picker plus a generic consistency warning.
 */
export function ImportLapsModal({ gameId, sessionId, tests, onClose }: { gameId: GameId; sessionId: number; tests: ExperimentVersion[]; onClose: () => void }) {
  const isF1 = gameId === "f1-2025";
  const { data: importable, isLoading } = useImportableLaps(sessionId);
  const importLaps = useImportLaps();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targetTestId, setTargetTestId] = useState<string>("");
  const [groupBySetup, setGroupBySetup] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const laps = useMemo(() => importable ?? [], [importable]);

  const groups = useMemo(() => {
    if (!isF1) return null;
    const map = new Map<string, { key: string; summary: string; laps: ImportableLap[] }>();
    for (const lap of laps) {
      const key = lap.setupFingerprint ?? UNKNOWN_SETUP_KEY;
      const summary = lap.setupFingerprint ? (lap.setupSummary ?? "Unknown setup") : "Unknown setup";
      const existing = map.get(key);
      if (existing) existing.laps.push(lap);
      else map.set(key, { key, summary, laps: [lap] });
    }
    return Array.from(map.values());
  }, [isF1, laps]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === laps.length ? new Set() : new Set(laps.map((l) => l.id))));
  };

  const toggleGroup = (groupLaps: ImportableLap[]) => {
    const ids = groupLaps.map((l) => l.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setError(null);
    try {
      await importLaps.mutateAsync({
        sessionId,
        lapIds: Array.from(selected),
        experimentVersionId: isF1 ? null : targetTestId ? Number(targetTestId) : null,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "Could not import laps");
    }
  };

  const showSetupWarning = (gameId === "acc" || gameId === "ac-evo") && selected.size > 0;

  const renderLapRow = (lap: ImportableLap) => (
    <label key={lap.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-app-surface-hover/60">
      <input type="checkbox" checked={selected.has(lap.id)} onChange={() => toggle(lap.id)} />
      <span className="text-app-text tabular-nums">{fmtLapTime(lap.lapTime)}</span>
      <span className="text-app-text-dim">{lap.isValid ? "Valid" : "Invalid"}</span>
      {lap.tuneName && <span className="text-app-text-dim truncate">{lap.tuneName}</span>}
      <span className="ml-auto text-app-text-muted">{new Date(lap.createdAt).toLocaleString()}</span>
    </label>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="wide" showCloseButton={false} className="max-h-[86vh] p-5">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-app-text">Add laps from history</DialogTitle>
          <DialogDescription className="text-xs text-app-text-dim">
            Attach laps already recorded for this car and track to this session, instead of driving fresh ones.
          </DialogDescription>
        </DialogHeader>

        {isF1 ? (
          <div className="text-xs text-app-text-dim bg-app-bg/60 border border-app-border rounded px-3 py-2">
            F1 laps are auto-sorted into setups from their in-car setup — matching setups merge, new ones become versions.
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-app-compact text-app-text-muted uppercase tracking-wider">Attach to</span>
            <select value={targetTestId} onChange={(e) => setTargetTestId(e.target.value)} className="bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs">
              <option value="">Session baseline (no specific version)</option>
              {tests.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {showSetupWarning && (
          <div className="text-xs text-status-warning bg-status-warning/10 border border-status-warning/30 rounded px-3 py-2">
            These laps were driven under whatever setup was saved at the time, which may not match the target version's setup file. Review them for consistency before relying on them for tuning
            advice.
          </div>
        )}

        <div className="flex items-center justify-between text-app-compact text-app-text-muted uppercase tracking-wider">
          <span>Importable laps ({laps.length})</span>
          <div className="flex items-center gap-3 normal-case">
            {isF1 && (
              <button type="button" onClick={() => setGroupBySetup((v) => !v)} className="text-app-text-dim hover:text-app-text">
                {groupBySetup ? "Ungroup" : "Group by setup"}
              </button>
            )}
            {laps.length > 0 && (
              <button type="button" onClick={toggleAll} className="text-app-text-dim hover:text-app-text">
                {selected.size === laps.length ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-[120px] overflow-y-auto border border-app-border rounded divide-y divide-app-border">
          {isLoading && <div className="text-xs text-app-text-dim p-3">Loading…</div>}
          {!isLoading && laps.length === 0 && <div className="text-xs text-app-text-dim p-3">No unattached laps match this session's car and track.</div>}
          {!isLoading && isF1 && groupBySetup && groups
            ? groups.map((g) => {
                const groupSelected = g.laps.every((l) => selected.has(l.id));
                return (
                  <div key={g.key}>
                    <label className="flex items-center gap-2 px-3 py-1.5 text-xs bg-app-bg/40 cursor-pointer hover:bg-app-surface-hover/60 font-medium">
                      <input type="checkbox" checked={groupSelected} onChange={() => toggleGroup(g.laps)} />
                      <span className="text-app-text truncate">{g.summary}</span>
                      <span className="ml-auto text-app-text-muted">
                        {g.laps.length} lap{g.laps.length === 1 ? "" : "s"}
                      </span>
                    </label>
                    <div className="divide-y divide-app-border">{g.laps.map((lap) => renderLapRow(lap))}</div>
                  </div>
                );
              })
            : laps.map((lap) => renderLapRow(lap))}
        </div>

        {error && <div className="text-xs text-status-danger">{error}</div>}

        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-app-border text-app-text-dim hover:text-app-text">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={importLaps.isPending || selected.size === 0}
            title={selected.size === 0 ? "Select at least one lap" : undefined}
            className="px-3 py-1.5 text-xs rounded bg-app-accent hover:bg-app-accent-hover disabled:opacity-40 text-app-on-filled font-semibold"
          >
            {importLaps.isPending ? "Importing…" : `Import ${selected.size || ""} lap${selected.size === 1 ? "" : "s"}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
