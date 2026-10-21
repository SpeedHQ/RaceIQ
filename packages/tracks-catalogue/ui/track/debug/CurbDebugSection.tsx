import { useState } from "react";
import { useTracksCatalogueHost } from "../../host";
import type { TrackBoundaries, TrackCurb } from "../../../contracts/types";

/**
 * CurbDebugSection — Curb data display with extract/recalibrate controls.
 */
export function CurbDebugSection({
  trackId,
  curbs,
  setCurbs,
  setBoundaries,
}: {
  trackId: string;
  curbs: TrackCurb[] | null;
  setCurbs: (c: TrackCurb[] | null) => void;
  setBoundaries: (b: TrackBoundaries | null) => void;
}) {
  const { m, Button, useGameId, operations } = useTracksCatalogueHost();
  const gid = useGameId() ?? undefined;
  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<{ lapsScanned: number; lapsWithCurbs: number; curbSegments: number; calibrated: boolean } | null>(null);

  const handleExtract = async () => {
    if (!gid) return;
    setExtracting(true);
    setResult(null);
    try {
      const data = await operations.extractCurbs(trackId);
      if (data) {
        setResult(data);

        // Refresh curb data and boundaries
        const [newCurbs, newBoundaries] = await Promise.all([
          operations.curbs(trackId, gid).catch(() => null),
          operations.boundaries(trackId, gid).catch(() => null),
        ]);
        setCurbs(newCurbs);
        setBoundaries(newBoundaries);
      }
    } catch (err) {
      console.error("Curb extraction failed:", err);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
      <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">{m.curbdebug_curbs()}</div>
      <div className="space-y-1 text-app-body">
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.curbdebug_segments()}</span>
          <span className="font-mono text-app-text">{curbs?.length ?? 0}</span>
        </div>
        {curbs && curbs.length > 0 && (
          <>
            <div className="flex justify-between">
              <span className="text-app-text-muted">{m.curbdebug_left()}</span>
              <span className="font-mono text-app-text">{curbs.filter((c) => c.side === "left").length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-app-text-muted">{m.curbdebug_right()}</span>
              <span className="font-mono text-app-text">{curbs.filter((c) => c.side === "right").length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-app-text-muted">{m.curbdebug_total_pts()}</span>
              <span className="font-mono text-app-text">{curbs.reduce((s, c) => s + c.points.length, 0)}</span>
            </div>
          </>
        )}
      </div>

      <Button
        onClick={handleExtract}
        disabled={extracting}
        className="mt-2 w-full px-2 py-1.5 text-app-label uppercase tracking-wider font-semibold rounded border transition-colors bg-(--surface-curb)/15 border-(--surface-curb)/50 text-(--surface-curb) hover:bg-(--surface-curb)/25 disabled:opacity-50"
      >
        {extracting ? m.curbdebug_extracting() : m.curbdebug_extract_curbs()}
      </Button>
      <p className="text-app-micro text-app-text-dim mt-1">{m.curbdebug_scan_description()}</p>

      {result && (
        <div className="mt-2 p-2 rounded bg-app-bg/80 border border-app-border text-app-caption font-mono space-y-0.5">
          <div>
            {m.curbdebug_laps_scanned()} <span className="text-app-text">{result.lapsScanned}</span>
          </div>
          <div>
            {m.curbdebug_laps_with_curbs()} <span className="text-(--surface-curb)">{result.lapsWithCurbs}</span>
          </div>
          <div>
            {m.curbdebug_curb_segments()} <span className="text-(--surface-curb)">{result.curbSegments}</span>
          </div>
          <div>
            {m.curbdebug_calibrated()} <span className={result.calibrated ? "text-status-success" : "text-status-warning"}>{result.calibrated ? m.trackdetail_yes() : m.curbdebug_no()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
