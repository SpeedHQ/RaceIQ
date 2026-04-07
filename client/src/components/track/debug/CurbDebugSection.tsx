import { useState } from "react";
import { useGameId } from "@/stores/game";
import { client } from "@/lib/rpc";
import type { TrackBoundaries, TrackCalibration, TrackCurb } from "../types";

/**
 * CurbDebugSection — Curb data display with extract/recalibrate controls.
 */
export function CurbDebugSection({
  trackOrdinal,
  curbs,
  setCurbs,
  setBoundaries,
  setCalibration,
}: {
  trackOrdinal: number;
  curbs: TrackCurb[] | null;
  setCurbs: (c: TrackCurb[] | null) => void;
  setBoundaries: (b: TrackBoundaries | null) => void;
  setCalibration: (c: TrackCalibration | null) => void;
}) {
  const gid = useGameId() ?? undefined;
  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<{ lapsScanned: number; lapsWithCurbs: number; curbSegments: number; calibrated: boolean } | null>(null);

  const handleExtract = async () => {
    if (!gid) return;
    setExtracting(true);
    setResult(null);
    try {
      const res = await client.api["track-curbs"][":ordinal"].extract.$post({ param: { ordinal: String(trackOrdinal) } });
      if (res.ok) {
        const data = await res.json();
        setResult(data);

        // Refresh curb data, boundaries, and calibration
        const calRes = await client.api["track-calibration"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) } }).catch(() => null);
        const [newCurbs, newBoundaries, newCal] = await Promise.all([
          client.api["track-curbs"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid ?? undefined } }).then((r) => r.ok ? r.json() as unknown as TrackCurb[] : null).catch(() => null),
          client.api["track-boundaries"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid ?? undefined } }).then((r) => r.ok ? r.json() as unknown as TrackBoundaries : null).catch(() => null),
          calRes?.ok ? calRes.json() : null,
        ]);
        setCurbs(newCurbs);
        setBoundaries(newBoundaries);
        setCalibration(newCal);
      }
    } catch (err) {
      console.error("Curb extraction failed:", err);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
      <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Curbs</div>
      <div className="space-y-1 text-app-body">
        <div className="flex justify-between">
          <span className="text-app-text-muted">Segments</span>
          <span className="font-mono text-app-text">{curbs?.length ?? 0}</span>
        </div>
        {curbs && curbs.length > 0 && (
          <>
            <div className="flex justify-between">
              <span className="text-app-text-muted">Left</span>
              <span className="font-mono text-app-text">{curbs.filter(c => c.side === "left").length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-app-text-muted">Right</span>
              <span className="font-mono text-app-text">{curbs.filter(c => c.side === "right").length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-app-text-muted">Total pts</span>
              <span className="font-mono text-app-text">{curbs.reduce((s, c) => s + c.points.length, 0)}</span>
            </div>
          </>
        )}
      </div>

      <button
        onClick={handleExtract}
        disabled={extracting}
        className="mt-2 w-full px-2 py-1.5 text-app-label uppercase tracking-wider font-semibold rounded border transition-colors bg-orange-900/40 border-orange-700/50 text-orange-400 hover:bg-orange-800/50 disabled:opacity-50"
      >
        {extracting ? "Extracting..." : "Extract Curbs from Laps"}
      </button>
      <p className="text-[9px] text-app-text-dim mt-1">
        Scans all stored laps for rumble strip data and recalibrates track boundaries.
      </p>

      {result && (
        <div className="mt-2 p-2 rounded bg-app-bg/80 border border-app-border text-[10px] font-mono space-y-0.5">
          <div>Laps scanned: <span className="text-app-text">{result.lapsScanned}</span></div>
          <div>Laps with curbs: <span className="text-orange-400">{result.lapsWithCurbs}</span></div>
          <div>Curb segments: <span className="text-orange-400">{result.curbSegments}</span></div>
          <div>Calibrated: <span className={result.calibrated ? "text-green-400" : "text-amber-400"}>{result.calibrated ? "Yes" : "No"}</span></div>
        </div>
      )}
    </div>
  );
}
