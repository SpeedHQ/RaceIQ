import { useEffect, useRef, useState } from "react";
import { drawTrack, type PitLine } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import type { GameId } from "../../../../shared/games/ids";
import type { Point, TrackInfo } from "./types";

const trackCardVisibilityCallbacks = new WeakMap<Element, () => void>();
let trackCardVisibilityObserver: IntersectionObserver | null = null;

function observeTrackCardVisibility(element: Element, onVisible: () => void): (() => void) | undefined {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return undefined;
  }
  if (!trackCardVisibilityObserver) {
    trackCardVisibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = trackCardVisibilityCallbacks.get(entry.target);
          if (!callback) continue;
          trackCardVisibilityObserver?.unobserve(entry.target);
          trackCardVisibilityCallbacks.delete(entry.target);
          callback();
        }
      },
      { rootMargin: "300px" },
    );
  }
  trackCardVisibilityCallbacks.set(element, onVisible);
  trackCardVisibilityObserver.observe(element);
  return () => {
    trackCardVisibilityObserver?.unobserve(element);
    trackCardVisibilityCallbacks.delete(element);
  };
}

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
  const cardRef = useRef<HTMLButtonElement>(null);
  const [outlineVisible, setOutlineVisible] = useState(false);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [pitLines, setPitLines] = useState<PitLine[]>([]);
  const [outlineState, setOutlineState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [flipX, setFlipX] = useState(false);

  useEffect(() => {
    if (!track.hasOutline || !cardRef.current) return;
    return observeTrackCardVisibility(cardRef.current, () => setOutlineVisible(true));
  }, [track.hasOutline]);
  useEffect(() => {
    if (!track.hasOutline || !outlineVisible) {
      setOutline(null);
      setPitLines([]);
      setFlipX(false);
      setOutlineState("idle");
      return;
    }
    const controller = new AbortController();
    setOutline(null);
    setPitLines([]);
    setFlipX(false);
    setOutlineState("loading");
    client.api["track-outline"][":ordinal"]
      .$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } }, { init: { signal: controller.signal } })
      .then((r) => r.json() as unknown as { points?: Point[]; pitLines?: PitLine[]; flipX?: boolean } | Point[])
      .then((data) => {
        if (!Array.isArray(data) && data?.points && Array.isArray(data.points)) {
          setOutline(data.points);
          setPitLines(Array.isArray(data.pitLines) ? data.pitLines : []);
          setFlipX(data.flipX ?? false);
          setOutlineState("ready");
        } else if (Array.isArray(data)) {
          setOutline(data);
          setPitLines([]);
          setOutlineState("ready");
        } else {
          setOutline(null);
          setPitLines([]);
          setOutlineState("unavailable");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setOutlineState("unavailable");
      });
    return () => controller.abort();
  }, [track.ordinal, track.hasOutline, gameId, outlineVisible]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, false, null, 1, { x: 0, z: 0 }, undefined, flipX, undefined, pitLines);
  }, [outline, flipX, pitLines]);

  return (
    <button
      type="button"
      ref={cardRef}
      data-testid={`track-card-${track.ordinal}`}
      className="w-full text-left border border-app-border rounded-lg overflow-hidden cursor-pointer transition-all bg-app-surface/50 hover:border-app-border-hover hover:bg-app-surface-hover/50"
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
        ) : track.hasOutline && outlineState !== "unavailable" ? (
          <div data-testid={`track-map-loading-${track.ordinal}`} className="h-full bg-app-surface-alt/20 animate-pulse" />
        ) : track.mapUrl ? (
          <img src={track.mapUrl} alt={`${track.name} ${track.variant} map`} className="w-full h-full object-contain p-3" loading="lazy" decoding="async" />
        ) : (
          <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">{m.trackcard_no_outline()}</div>
        )}
        {(setupCount !== undefined || guideCount !== undefined) && (
          <div className="absolute bottom-1.5 right-1.5 flex flex-col items-end gap-1 pointer-events-none">
            {setupCount !== undefined && (
              <span
                className={`text-app-caption px-1.5 py-0.5 rounded border font-mono leading-none ${
                  setupCount > 0 ? "bg-status-success/15 border-status-success/50 text-status-success" : "bg-app-surface-alt/70 border-app-border text-app-text-dim"
                }`}
              >
                {setupCount} {setupCount === 1 ? m.trackcard_setup_count() : m.trackcard_setup_counts()}
              </span>
            )}
            {guideCount !== undefined && (
              <span
                className={`text-app-caption px-1.5 py-0.5 rounded border font-mono leading-none ${
                  guideCount > 0 ? "bg-status-warning/15 border-status-warning/50 text-status-warning" : "bg-app-surface-alt/70 border-app-border text-app-text-dim"
                }`}
              >
                {guideCount} {guideCount === 1 ? m.trackcard_guide_count() : m.trackcard_guide_counts()}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
