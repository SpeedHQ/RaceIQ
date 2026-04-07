import { useEffect, useState, useRef } from "react";
import type { GameId } from "@shared/types";
import { client } from "@/lib/rpc";
import { drawTrack } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import type { TrackInfo, Point } from "./types";

/** TrackCard — Gallery thumbnail: fetches outline by ordinal and renders a small static track map. */
export function TrackCard({ track, onSelect, gameId }: { track: TrackInfo; onSelect: (t: TrackInfo) => void; gameId?: GameId | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);

  useEffect(() => {
    if (!track.hasOutline) return;
    client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as unknown as { points?: Point[] } | Point[])
      .then((data) => {
        if (!Array.isArray(data) && data?.points && Array.isArray(data.points)) setOutline(data.points);
        else if (Array.isArray(data)) setOutline(data);
        else setOutline(null);
      })
      .catch(() => {});
  }, [track.ordinal, track.hasOutline, gameId]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, false, null);
  }, [outline]);

  return (
    <div
      className="border border-app-border rounded-lg overflow-hidden cursor-pointer transition-all bg-app-surface/50 hover:border-app-border-input hover:bg-app-surface-alt/50"
      onClick={() => onSelect(track)}
    >
      <div className="p-3">
        <div className="text-app-body font-medium text-app-text">{track.name}</div>
        <div className="text-app-label text-app-text-muted">
          {track.variant} · {track.location}, {countryName(track.country)}
          {track.lengthKm > 0 && ` · ${track.lengthKm} km`}
        </div>
      </div>
      <div className="bg-app-bg" style={{ height: 150 }}>
        {track.hasOutline ? (
          <canvas ref={canvasRef} className="w-full h-full" />
        ) : (
          <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">
            No outline available
          </div>
        )}
      </div>
    </div>
  );
}
