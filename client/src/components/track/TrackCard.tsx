import { useEffect, useState, useRef } from "react";
import type { GameId } from "@shared/types";
import { client } from "@/lib/rpc";
import { drawTrack } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import type { TrackInfo, Point } from "./types";

/** TrackCard — Gallery thumbnail: fetches outline by ordinal and renders a small static track map. */
export function TrackCard({ track, onSelect, gameId, setupCount, guideCount, hasGuide }: { track: TrackInfo; onSelect: (t: TrackInfo) => void; gameId?: GameId | null; setupCount?: number; guideCount?: number; hasGuide?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [flipX, setFlipX] = useState(false);

  useEffect(() => {
    if (!track.hasOutline) return;
    client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as unknown as { points?: Point[]; flipX?: boolean } | Point[])
      .then((data) => {
        if (!Array.isArray(data) && data?.points && Array.isArray(data.points)) {
          setOutline(data.points);
          setFlipX(data.flipX ?? false);
        } else if (Array.isArray(data)) {
          setOutline(data);
        } else {
          setOutline(null);
        }
      })
      .catch(() => {});
  }, [track.ordinal, track.hasOutline, gameId]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, false, null, 1, { x: 0, z: 0 }, undefined, flipX);
  }, [outline, flipX]);

  return (
    <div
      className="border border-app-border rounded-lg overflow-hidden cursor-pointer transition-all bg-app-surface/50 hover:border-app-border-input hover:bg-app-surface-alt/50"
      onClick={() => onSelect(track)}
    >
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="text-app-body font-medium text-app-text">{track.name}</div>
          <span className="shrink-0 text-app-label px-1.5 py-0.5 rounded bg-app-surface-alt border border-app-border text-app-text-muted">
            {track.lapCount ?? 0} {(track.lapCount ?? 0) === 1 ? "lap" : "laps"}
          </span>
        </div>
        <div className="text-app-label text-app-text-muted">
          {track.variant} · {track.location}, {countryName(track.country)}
          {track.lengthKm > 0 && ` · ${track.lengthKm} km`}
        </div>
      </div>
      <div className="bg-app-bg relative" style={{ height: 150 }}>
        {track.hasOutline ? (
          <canvas ref={canvasRef} className="w-full h-full" />
        ) : (
          <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">
            No outline available
          </div>
        )}
        {(setupCount !== undefined || hasGuide !== undefined) && (
          <div className="absolute bottom-1.5 right-1.5 flex flex-col items-end gap-1 pointer-events-none">
            {(setupCount ?? 0) > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/70 border border-green-700/50 text-green-300 font-mono leading-none">
                {setupCount} setup{setupCount !== 1 ? "s" : ""}
              </span>
            )}
            {(guideCount ?? 0) > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/70 border border-orange-700/50 text-orange-300 font-mono leading-none">
                {guideCount} guide{guideCount !== 1 ? "s" : ""}
              </span>
            )}
            {hasGuide && (guideCount ?? 0) === 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/70 border border-orange-700/50 text-orange-300 font-mono leading-none">
                guide
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
