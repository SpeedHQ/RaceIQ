import { useEffect, useState } from "react";
import { client } from "@/lib/rpc";
import { useGameId } from "@/stores/game";
import type { Point, TrackBoundaries, TrackCurb, TrackSectors } from "../types";
import { CurbDebugSection } from "./CurbDebugSection";

/** Diagnostics and curb controls for geometry workspaces. Map drawing belongs to TrackMapCanvas. */
export function TrackDebugPanel({
  trackOrdinal,
  outline,
  displaySectors: _displaySectors,
  sectorBounds: _sectorBounds,
  editingSegments: _editingSegments,
  editingSectors: _editingSectors,
  trackLengthKm: _trackLengthKm,
  trackCreatedAt: _trackCreatedAt,
  corners: _corners,
  straights: _straights,
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
    if (!gid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackBoundaries) : null))
        .catch(() => null),
      client.api["track-curbs"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackCurb[]) : null))
        .catch(() => null),
    ]).then(([nextBoundaries, nextCurbs]) => {
      setBoundaries(nextBoundaries);
      setCurbs(nextCurbs);
      setLoading(false);
    });
  }, [trackOrdinal, gid]);

  if (loading) return <div className="text-app-subtext text-app-text-dim py-8 text-center">Loading debug data...</div>;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
        <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Outline</div>
        <div className="flex justify-between text-app-body">
          <span className="text-app-text-muted">Points</span>
          <span className="font-mono text-app-text">{outline?.length ?? 0}</span>
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
              <div className="flex justify-between"><span className="text-app-text-muted">Left edge pts</span><span className="font-mono text-app-text">{boundaries.leftEdge.length}</span></div>
              <div className="flex justify-between"><span className="text-app-text-muted">Right edge pts</span><span className="font-mono text-app-text">{boundaries.rightEdge.length}</span></div>
              <div className="flex justify-between"><span className="text-app-text-muted">Coord system</span><span className="font-mono text-app-text">{boundaries.coordSystem}</span></div>
              <div className="flex justify-between"><span className="text-app-text-muted">Pit lane</span><span className={`font-mono ${boundaries.pitLane ? "text-status-success" : "text-app-text-dim"}`}>{boundaries.pitLane ? `${boundaries.pitLane.length} pts` : "None"}</span></div>
            </>
          )}
        </div>
      </div>

      <CurbDebugSection trackOrdinal={trackOrdinal} curbs={curbs} setCurbs={setCurbs} setBoundaries={setBoundaries} />
    </div>
  );
}
