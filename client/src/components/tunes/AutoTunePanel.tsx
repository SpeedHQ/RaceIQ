import { useState } from "react";
import type { LapMeta } from "@shared/types";
import { useSetupFiles, useAutoTune, type AutoTuneResult } from "../../hooks/queries";

interface AutoTunePanelProps {
  gameId: "acc" | "ac-evo";
  laps: LapMeta[];
  trackName?: string;
}

/**
 * AutoTunePanel — lets the driver pick a completed stint + a setup file on
 * disk, run the symptom→intent→apply auto-tune pipeline as a preview, review
 * the reasoning, then write it to the setup file.
 */
export function AutoTunePanel({ gameId, laps, trackName }: AutoTunePanelProps) {
  const [stintId, setStintId] = useState<number | "">("");
  const [filePath, setFilePath] = useState<string>("");
  const [result, setResult] = useState<AutoTuneResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
  const autoTune = useAutoTune();

  const validLaps = [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber);

  async function runPreview() {
    if (!stintId || !filePath) return;
    setError(null);
    setResult(null);
    try {
      const res = await autoTune.mutateAsync({ gameId, stintId: Number(stintId), filePath, trackName, preview: true });
      setResult(res);
    } catch (err: any) {
      setError(err?.message ?? "Auto-tune failed");
    }
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
      <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Auto-Tune</h2>

      <div className="grid grid-cols-1 gap-2">
        <label className="text-xs text-app-text-dim">
          Stint / Lap
          <select
            className="mt-1 w-full bg-app-panel border border-app-border rounded px-2 py-1 text-sm"
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

        <label className="text-xs text-app-text-dim">
          Setup file
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
          <button
            onClick={runPreview}
            disabled={!stintId || !filePath || autoTune.isPending}
            className="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white"
          >
            {autoTune.isPending ? "Analysing…" : "Preview"}
          </button>
          <button
            onClick={applyToFile}
            disabled={!result || autoTune.isPending}
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
          {result.applied.length === 0 ? (
            <div className="text-xs text-app-text-dim">No changes recommended.</div>
          ) : (
            <ul className="space-y-1">
              {result.applied.map((a, i) => (
                <li key={i} className="text-xs text-app-text">
                  <span className="font-mono text-purple-400">{a.component}</span>: {a.from} → {a.to}{" "}
                  <span className="text-app-text-dim">({a.reason})</span>
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="space-y-1">
              {result.skipped.map((s, i) => (
                <li key={i} className="text-xs text-yellow-500">
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
