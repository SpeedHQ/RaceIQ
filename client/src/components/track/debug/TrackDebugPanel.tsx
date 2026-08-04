import { useEffect, useState } from "react";
import { client } from "@/lib/rpc";
import { useGameId } from "@/stores/game";
import type { Point, TrackBoundaries, TrackCurb, TrackSectors } from "../types";
import { CurbDebugSection } from "./CurbDebugSection";
import { TrackDebugCanvas } from "./TrackDebugCanvas";

/**
 * TrackDebugPanel — Full-page debug visualization for track boundary data.
 * Shows outline + boundaries on a large canvas with drag/zoom and diagnostic info sidebar.
 */
export function TrackDebugPanel({
  trackOrdinal,
  outline,
  flipX = false,
  displaySectors,
  sectorBounds,
  editingSegments,
  editingSectors,
  trackLengthKm,
  trackCreatedAt,
  corners,
  straights,
}: {
  trackOrdinal: number;
  outline: Point[] | null;
  flipX?: boolean;
  displaySectors?: TrackSectors | null;
  sectorBounds?: { s1End: number; s2End: number } | null;
  editingSegments?: boolean;
  editingSectors?: boolean;
  trackLengthKm?: number;
  trackCreatedAt?: string;
  corners?: number;
  straights?: number;
}) {
  const gid = useGameId() ?? undefined;
  const [boundaries, setBoundaries] = useState<TrackBoundaries | null>(null);
  const [curbs, setCurbs] = useState<TrackCurb[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!gid) return;
    setLoading(true);
    Promise.all([
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid ?? undefined } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackBoundaries) : null))
        .catch(() => null),
      client.api["track-curbs"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid ?? undefined } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackCurb[]) : null))
        .catch(() => null),
    ]).then(([b, c]) => {
      setBoundaries(b);
      setCurbs(c);
      setLoading(false);
    });
  }, [trackOrdinal, gid]);

  if (loading) {
    return <div className="text-app-subtext text-app-text-dim py-8 text-center">Loading debug data...</div>;
  }

  return (
    <div className="grid h-auto grid-cols-1 gap-4 @5xl/workspace:h-[calc(100vh-160px)] @5xl/workspace:grid-cols-[1fr_280px]">
      <TrackDebugCanvas
        outline={outline}
        boundaries={boundaries}
        curbs={curbs}
        flipX={flipX}
        displaySectors={displaySectors}
        sectorBounds={sectorBounds}
        editingSegments={editingSegments}
        editingSectors={editingSectors}
        trackLengthKm={trackLengthKm}
        trackCreatedAt={trackCreatedAt}
        corners={corners}
        straights={straights}
      />

      {/* Info sidebar */}
      <div className="flex flex-col gap-3 overflow-auto">
        <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Outline</div>
          <div className="space-y-1 text-app-body">
            <div className="flex justify-between">
              <span className="text-app-text-muted">Points</span>
              <span className="font-mono text-app-text">{outline?.length ?? 0}</span>
            </div>
          </div>
        </div>

        <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Boundaries</div>
          <div className="space-y-1 text-app-body">
            <div className="flex justify-between">
              <span className="text-app-text-muted">Available</span>
              <span className={`font-mono ${boundaries ? "text-status-success" : "text-status-danger"}`}>{boundaries ? "Yes" : "No"}</span>
            </div>
            {boundaries && (
              <>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Left edge pts</span>
                  <span className="font-mono text-app-text">{boundaries.leftEdge.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Right edge pts</span>
                  <span className="font-mono text-app-text">{boundaries.rightEdge.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Coord system</span>
                  <span className="font-mono text-app-text">{boundaries.coordSystem}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Pit lane</span>
                  <span className={`font-mono ${boundaries.pitLane ? "text-status-success" : "text-app-text-dim"}`}>{boundaries.pitLane ? `${boundaries.pitLane.length} pts` : "None"}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <CurbDebugSection trackOrdinal={trackOrdinal} curbs={curbs} setCurbs={setCurbs} setBoundaries={setBoundaries} />
      </div>
    </div>
  );
}
