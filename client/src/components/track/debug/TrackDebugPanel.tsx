import { m } from "@/paraglide/messages";
import { useEffect, useState } from "react";
import { client } from "@/lib/rpc";
import { useGameId } from "@/stores/game";
import type { Point, TrackBoundaries, TrackCurb, TrackSectors } from "../types";
import { InlineTrackMap } from "../InlineTrackMap";
import { CalibrationComparisonSection } from "./CalibrationComparisonSection";
import type { CalibrationComparison } from "./calibration-comparison";
import { CurbDebugSection } from "./CurbDebugSection";
import { TrackDebugCanvas } from "./TrackDebugCanvas";

/**
 * TrackDebugPanel — Full-page debug visualization for track boundary data.
 * Shows outline + boundaries on a large canvas with drag/zoom and diagnostic info sidebar.
 */
export function TrackDebugPanel({
  trackOrdinal,
  outline,
  mapUrl,
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
  mapUrl?: string | null;
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
  const [calibrationComparison, setCalibrationComparison] = useState<CalibrationComparison | null>(null);
  const [showCalibrationHistory, setShowCalibrationHistory] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!gid) return;
    setLoading(true);
    Promise.all([
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: encodeURIComponent(String(trackOrdinal)) }, query: { gameId: gid ?? undefined } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackBoundaries) : null))
        .catch(() => null),
      client.api["track-curbs"][":ordinal"]
        .$get({ param: { ordinal: encodeURIComponent(String(trackOrdinal)) }, query: { gameId: gid ?? undefined } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackCurb[]) : null))
        .catch(() => null),
      client.api["track-calibration"][":ordinal"].comparison
        .$get({ param: { ordinal: encodeURIComponent(String(trackOrdinal)) } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([b, c, comparison]) => {
      setBoundaries(b);
      setCurbs(c);
      setCalibrationComparison(comparison);
      setLoading(false);
    });
  }, [trackOrdinal, gid]);

  if (loading) {
    return <div className="text-app-subtext text-app-text-dim py-8 text-center">{m.trackdebugpanel_loading()}</div>;
  }

  return (
    <div className="grid h-auto grid-cols-1 gap-4 @5xl/workspace:h-[calc(100vh-160px)] @5xl/workspace:grid-cols-[1fr_280px]">
      {mapUrl?.startsWith("/api/lmu-assets/") ? (
        <div className="min-h-0 rounded-lg border border-app-border bg-app-bg">
          <InlineTrackMap src={mapUrl} alt={m.trackdebugpanel_lmu_geometry()} layers="debug" className="h-full w-full p-3" />
        </div>
      ) : (
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
          calibrationComparison={calibrationComparison}
          showCalibrationHistory={showCalibrationHistory}
        />
      )}

      {/* Info sidebar */}
      <div className="flex flex-col gap-3 overflow-auto">
        <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">{m.trackdebugpanel_outline()}</div>
          <div className="space-y-1 text-app-body">
            <div className="flex justify-between">
              <span className="text-app-text-muted">{m.trackdebugpanel_points()}</span>
              <span className="font-mono text-app-text">{outline?.length ?? 0}</span>
            </div>
          </div>
        </div>

        <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">{m.trackdebugpanel_boundaries()}</div>
          <div className="space-y-1 text-app-body">
            <div className="flex justify-between">
              <span className="text-app-text-muted">{m.trackdebugpanel_available()}</span>
              <span className={`font-mono ${boundaries ? "text-status-success" : "text-status-danger"}`}>{boundaries ? m.trackdetail_yes() : m.curbdebug_no()}</span>
            </div>
            {boundaries && (
              <>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">{m.trackdebugpanel_left_edge_pts()}</span>
                  <span className="font-mono text-app-text">{boundaries.leftEdge.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">{m.trackdebugpanel_right_edge_pts()}</span>
                  <span className="font-mono text-app-text">{boundaries.rightEdge.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">{m.trackdebugpanel_coord_system()}</span>
                  <span className="font-mono text-app-text">{boundaries.coordSystem}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">{m.trackdebugpanel_pit_lane()}</span>
                  <span className={`font-mono ${boundaries.pitLane ? "text-status-success" : "text-app-text-dim"}`}>{boundaries.pitLane ? `${boundaries.pitLane.length} pts` : m.trackdebugpanel_none()}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <CalibrationComparisonSection comparison={calibrationComparison} showHistory={showCalibrationHistory} onShowHistoryChange={setShowCalibrationHistory} />
        <CurbDebugSection trackOrdinal={trackOrdinal} curbs={curbs} setCurbs={setCurbs} setBoundaries={setBoundaries} />
      </div>
    </div>
  );
}
