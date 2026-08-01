import type { LapMeta } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import { NoSetupsHint, SetupEngineerControls, SetupEngineerResult, useSetupEngineer } from "./SetupEngineer";

/** Single reload target for live auto-apply — overwritten each lap. */
const AUTO_SETUP_NAME = "RaceIQ_auto_setup";

interface AutoTunePanelProps {
  gameId: "acc" | "ac-evo";
  laps: LapMeta[];
  trackName?: string;
  /**
   * Live mode: auto-select the newest valid lap and auto-run the recommendation
   * each time a new hot lap completes — hands-free advice after every lap.
   */
  liveMode?: boolean;
  /** When set, act on this exact lap and hide the internal lap picker. */
  fixedLapId?: number;
}

/**
 * AutoTunePanel — the Setup Engineer as a self-contained panel (used by the live
 * cockpit). Owns lap selection and, in live mode, re-runs the recommendation as
 * each fresh lap arrives. The post-lap review dashboard doesn't use this — it
 * places the controls in its toolbar via the shared SetupEngineer pieces.
 */
export function AutoTunePanel({ gameId, laps, trackName, liveMode = false, fixedLapId }: AutoTunePanelProps) {
  const state = useSetupEngineer(gameId, trackName);
  const [stintId, setStintId] = useState<number | "">("");
  const activeLapId = fixedLapId ?? (stintId === "" ? undefined : Number(stintId));

  const validLaps = [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber);
  const newestValidLapId = validLaps[0]?.id;

  // Live mode: follow the newest valid lap and auto-run once per new lap.
  const lastAutoRunLapId = useRef<number | null>(null);
  useEffect(() => {
    if (!liveMode || newestValidLapId == null || !state.filePath) return;
    setStintId(newestValidLapId);
    if (lastAutoRunLapId.current === newestValidLapId) return;
    if (state.isPending) return; // let the in-flight run finish; next lap re-triggers
    lastAutoRunLapId.current = newestValidLapId;
    void state.runPreviewFor(newestValidLapId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, newestValidLapId, state.filePath]);

  // Live auto-apply: when a fresh recommendation lands and a base setup is
  // selected, overwrite the single RaceIQ_auto_setup file so the driver just
  // reloads it in-game. Once per lap.
  const [autoApply, setAutoApply] = useState(false);
  const lastAutoAppliedLapId = useRef<number | null>(null);
  useEffect(() => {
    if (!liveMode || !autoApply || !state.filePath) return;
    const r = state.result;
    if (!r?.preview || r.written || r.hasSetup === false || r.applied.length === 0) return;
    if (state.isPending || lastAutoAppliedLapId.current === newestValidLapId) return;
    lastAutoAppliedLapId.current = newestValidLapId ?? null;
    void state.applyToFile(AUTO_SETUP_NAME, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, autoApply, state.result, state.filePath, newestValidLapId]);

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Race engineer</h2>
        {liveMode && (
          <span className="flex items-center gap-1.5 text-app-compact text-status-danger">
            <span className="w-2 h-2 rounded-full bg-status-danger animate-pulse" />
            Live — updates each lap
          </span>
        )}
      </div>

      {fixedLapId == null && (
        <label className="block text-app-label text-app-text-dim">
          Stint / Lap
          <select
            className="mt-1 w-full bg-app-dropdown border border-app-border rounded px-2 py-1 text-app-detail"
            value={stintId}
            onChange={(e) => setStintId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">Select a completed lap…</option>
            {validLaps.map((l) => (
              <option key={l.id} value={l.id}>
                Lap {l.lapNumber} — {l.lapTime.toFixed(3)}s
              </option>
            ))}
          </select>
        </label>
      )}

      <SetupEngineerControls state={state} lapId={activeLapId} />
      <NoSetupsHint state={state} />

      {liveMode && (
        <label className="flex items-center gap-2 text-xs text-app-text-dim">
          <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} disabled={!state.filePath} className="accent-app-accent" />
          <span>
            Auto-apply each lap → <span className="font-mono text-app-text">{AUTO_SETUP_NAME}.json</span>
          </span>
          {autoApply && state.filePath && <span className="text-status-success">on — reload it in-game</span>}
          {!state.filePath && <span className="text-app-text-muted">(pick a base setup first)</span>}
        </label>
      )}

      <SetupEngineerResult state={state} />
    </div>
  );
}
