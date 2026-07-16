import type { LapMeta } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import { type AutoTuneResult, useAutoTune, useSetupFiles } from "../../hooks/queries";

interface AutoTunePanelProps {
  gameId: "acc" | "ac-evo";
  laps: LapMeta[];
  trackName?: string;
  /**
   * Live mode: auto-select the newest valid lap and auto-run the recommendation
   * each time a new hot lap completes. Used while the driver is on-track doing
   * practice laps — hands-free directional advice after every lap.
   */
  liveMode?: boolean;
}

/**
 * AutoTunePanel — lets the driver pick a completed stint + a setup file on
 * disk, run the symptom→intent→apply auto-tune pipeline as a preview, review
 * the reasoning, then write it to the setup file. In live mode it re-runs the
 * recommendation automatically as each fresh lap comes in.
 */
export function AutoTunePanel({ gameId, laps, trackName, liveMode = false }: AutoTunePanelProps) {
  const [stintId, setStintId] = useState<number | "">("");
  const [filePath, setFilePath] = useState<string>("");
  const [result, setResult] = useState<AutoTuneResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
  const autoTune = useAutoTune();

  const validLaps = [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber);
  const newestValidLapId = validLaps[0]?.id;

  // Run a preview/recommendation for a specific lap. Returns nothing; updates
  // result/error state. Kept separate from the button handler so the live
  // effect can drive it without going through the stintId state round-trip.
  async function runPreviewFor(lapId: number) {
    setError(null);
    setResult(null);
    try {
      const res = await autoTune.mutateAsync({
        gameId,
        stintId: lapId,
        filePath: filePath || undefined,
        trackName,
        preview: true,
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.message ?? "Auto-tune failed");
    }
  }

  // Live mode: follow the newest valid lap and auto-run once per new lap.
  const lastAutoRunLapId = useRef<number | null>(null);
  useEffect(() => {
    if (!liveMode || newestValidLapId == null) return;
    setStintId(newestValidLapId);
    if (lastAutoRunLapId.current === newestValidLapId) return;
    if (autoTune.isPending) return; // let the in-flight run finish; next lap re-triggers
    lastAutoRunLapId.current = newestValidLapId;
    void runPreviewFor(newestValidLapId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, newestValidLapId]);

  async function runPreview() {
    if (!stintId) return;
    await runPreviewFor(Number(stintId));
  }

  async function applyToFile() {
    if (!stintId || !filePath) return;
    setError(null);
    try {
      const res = await autoTune.mutateAsync({ gameId, stintId: Number(stintId), filePath, trackName, preview: false });
      setResult(res);
    } catch (err: any) {
      setError(err?.message ?? "Auto-tune failed");
    }
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Setup Engineer</h2>
        {liveMode && (
          <span className="flex items-center gap-1.5 text-[11px] text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            Live — updates each lap
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2">
        <label className="text-xs text-app-text-dim">
          Stint / Lap
          <select className="mt-1 w-full bg-app-panel border border-app-border rounded px-2 py-1 text-sm" value={stintId} onChange={(e) => setStintId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select a completed lap…</option>
            {validLaps.map((l) => (
              <option key={l.id} value={l.id}>
                Lap {l.lapNumber} — {l.lapTime.toFixed(3)}s
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-app-text-dim">
          Setup file <span className="text-app-text-muted">(optional)</span>
          <select
            className="mt-1 w-full bg-app-panel border border-app-border rounded px-2 py-1 text-sm"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            disabled={loadingFiles || !setupFiles?.files?.length}
          >
            <option value="">{loadingFiles ? "Loading…" : setupFiles?.files?.length ? "Select a setup file…" : "No setup files found"}</option>
            {setupFiles?.files?.map((f) => (
              <option key={f.absolutePath} value={f.absolutePath}>
                {f.carModel} / {f.trackName} / {f.fileName}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={runPreview} disabled={!stintId || autoTune.isPending} className="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white">
            {autoTune.isPending ? "Analysing…" : filePath ? "Preview" : "Recommend"}
          </button>
          <button
            type="button"
            onClick={applyToFile}
            disabled={!result || !filePath || autoTune.isPending}
            className="px-2 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white"
          >
            Apply to file
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {result && (
        <div className="border-t border-app-border pt-2 space-y-2">
          <div className="text-xs text-app-text-dim">Model: {result.model}</div>

          {result.hasSetup === false ? (
            // Lap-only recommendation: no setup to apply to, show advisory intents.
            <>
              <div className="text-xs text-yellow-500">No setup file selected — directional recommendation only (not applied, less precise).</div>
              {result.intents.length === 0 ? (
                <div className="text-xs text-app-text-dim">No changes recommended.</div>
              ) : (
                <ul className="space-y-1">
                  {result.intents.map((it, i) => (
                    <li key={`${it.component}-${i}`} className="text-xs text-app-text">
                      <span className="font-mono text-purple-400">{it.component}</span>: {it.direction} ({it.magnitude}) <span className="text-app-text-dim">({it.reason})</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : result.applied.length === 0 ? (
            <div className="text-xs text-app-text-dim">No changes recommended.</div>
          ) : (
            <ul className="space-y-1">
              {result.applied.map((a, i) => (
                <li key={`${a.component}-${i}`} className="text-xs text-app-text">
                  <span className="font-mono text-purple-400">{a.component}</span>: {a.from} → {a.to} <span className="text-app-text-dim">({a.reason})</span>
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="space-y-1">
              {result.skipped.map((s, i) => (
                <li key={`${s.component}-${i}`} className="text-xs text-yellow-500">
                  Skipped {s.component}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          {result.written && <div className="text-xs text-emerald-400">Written to {result.written.path}</div>}
          {result.preview && <div className="text-xs text-app-text-dim">Preview only — click "Apply to file" to write.</div>}
        </div>
      )}
    </div>
  );
}
