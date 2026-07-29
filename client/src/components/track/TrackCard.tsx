import type { GameId } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import { drawTrack } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import type { Point, TrackInfo } from "./types";

/** TrackCard — Gallery thumbnail: fetches outline by ordinal and renders a small static track map. */
export function TrackCard({
  track,
  onSelect,
  gameId,
  setupCount,
  guideCount,
}: {
  track: TrackInfo;
  onSelect: (t: TrackInfo) => void;
  gameId?: GameId | null;
  setupCount?: number;
  guideCount?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [flipX, setFlipX] = useState(false);

  useEffect(() => {
    if (!track.hasOutline) return;
    client.api["track-outline"][":ordinal"]
      .$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } })
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
            {track.lapCount ?? 0} {(track.lapCount ?? 0) === 1 ? m.trackcard_lap_singular() : m.pitwindow_laps()}
          </span>
        </div>
        <div className="text-app-label text-app-text-muted">
          {track.variant} · {track.location}, {countryName(track.country)}
          {track.lengthKm > 0 && ` · ${track.lengthKm} km`}
        </div>
      </div>
      <div className="bg-app-bg relative" style={{ height: 150 }}>
        {outline ? (
          <canvas ref={canvasRef} className="w-full h-full" />
        ) : track.mapUrl ? (
          <img
            src={track.mapUrl}
            alt={`${track.name} ${track.variant} map`}
            className="w-full h-full object-contain p-3"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">{m.trackcard_no_outline()}</div>
        )}
        {(setupCount !== undefined || guideCount !== undefined) && (
          <div className="absolute bottom-1.5 right-1.5 flex flex-col items-end gap-1 pointer-events-none">
            {setupCount !== undefined && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border font-mono leading-none ${
                  setupCount > 0 ? "bg-green-900/70 border-green-700/50 text-green-300" : "bg-app-surface-alt/70 border-app-border text-app-text-dim"
                }`}
              >
                {setupCount} {setupCount === 1 ? m.trackcard_setup_count() : m.trackcard_setup_counts()}
              </span>
            )}
            {guideCount !== undefined && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border font-mono leading-none ${
                  guideCount > 0 ? "bg-orange-900/70 border-orange-700/50 text-orange-300" : "bg-app-surface-alt/70 border-app-border text-app-text-dim"
                }`}
              >
                {guideCount} {guideCount === 1 ? m.trackcard_guide_count() : m.trackcard_guide_counts()}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
