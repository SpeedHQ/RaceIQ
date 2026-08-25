import type { GameId } from "../../../../shared/games/ids";
import type { RefObject } from "react";
import type { AnalysisHighlight } from "@/components/ai/analysis-types";
import type { PitLine } from "@/lib/canvas/draw-track";
import { m } from "../../paraglide/messages";
import { ChevronDownIcon } from "lucide-react";
import { Compass } from "../Compass";
import { Button } from "../ui/button";
import { DropdownMenu } from "../ui/DropdownMenu";
import { AnalyseTrackMap } from "./AnalyseTrackMap";
import {
  DEFAULT_TRACK_OVERLAYS,
  type Point,
  type SectorBoundaries,
  type SemanticAnalysisFrame,
  type TrackMapBoundaries,
  type TrackMapHandle,
  type TrackMapLabel,
  type TrackOverlayKey,
  type TrackOverlays,
} from "./track-map/types";
import { WeatherWidget } from "./WeatherWidget";

interface AnalyseTrackPanelProps {
  gameId?: GameId;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: Point[] | null;
  mapLabels?: TrackMapLabel[] | null;
  pitLines?: PitLine[] | null;
  boundaries: TrackMapBoundaries | null;
  sectors: SectorBoundaries | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  currentFrame: SemanticAnalysisFrame | null;

  aiPanelOpen?: boolean;
  aiHighlights?: AnalysisHighlight[] | null;

  rotateWithCar: boolean;
  trackOverlays: TrackOverlays;
  mapZoom: number;
  /** Live view passes false to draw only track edges, not the driving line. */
  showTrace?: boolean;
  onRotateWithCarToggle: () => void;
  onTrackOverlayChange?: (overlay: TrackOverlayKey, checked: boolean) => void;
  onMapZoomChange: (updater: (z: number) => number) => void;

  trackMapRef?: RefObject<TrackMapHandle | null>;

  /** Live dashboard passes true to hide the steering wheel/pedal overlay and the inputs overlay toggle. */
  hideSteeringOverlay?: boolean;
  /** Live dashboard passes true to move the weather widget to the bottom-right instead of bottom-left. */
  weatherBottomRight?: boolean;
}

/**
 * AnalyseTrackPanel — the track map + overlays block (map, weather widget,
 * rotate/overlay toggles, zoom, compass, steering/pedal overlay). Extracted
 * from AnalyseTopSection's middle column so Analyse and the Setup Engineer
 * live dashboard render the identical panel instead of each re-assembling it.
 * Always renders — no live packet just means the compass/steering overlay
 * and weather widget stay hidden, not the whole panel.
 */
export function AnalyseTrackPanel({
  gameId,
  telemetry,
  cursorIdx,
  outline,
  mapLabels,
  pitLines,
  boundaries,
  sectors,
  segments,
  currentFrame,
  aiPanelOpen,
  aiHighlights,
  rotateWithCar,
  trackOverlays,
  mapZoom,
  showTrace,
  onRotateWithCarToggle,
  onTrackOverlayChange,
  onMapZoomChange,
  trackMapRef,
  hideSteeringOverlay,
  weatherBottomRight,
}: AnalyseTrackPanelProps) {
  const hasRacingLine = Array.isArray(boundaries?.raceLine) && boundaries.raceLine.length > 1;
  const anyTrackOverlay = Object.values(trackOverlays).some(Boolean);
  const overlayItems = (Object.keys(DEFAULT_TRACK_OVERLAYS) as TrackOverlayKey[])
    .filter((overlay) => overlay !== "racingLine" || hasRacingLine)
    .map((overlay) => ({
      type: "checkbox" as const,
      key: overlay,
      label: overlay === "inputs" ? m.overlay_inputs() : overlay === "segments" ? m.overlay_segments() : overlay === "sectors" ? m.overlay_sectors() : m.overlay_racing_line(),
      checked: trackOverlays[overlay],
      onCheckedChange: (checked: boolean) => onTrackOverlayChange?.(overlay, checked),
    }));

  return (
    <div
      data-testid="analyse-track-map-panel"
      className="relative h-full min-w-0 bg-app-bg p-2"
      onWheel={(e) => {
        if (!rotateWithCar) return;
        e.preventDefault();
        onMapZoomChange((z) => Math.max(0.5, Math.min(4, z - e.deltaY * 0.001)));
      }}
    >
      <AnalyseTrackMap
        ref={trackMapRef}
        gameId={gameId}
        telemetry={telemetry}
        cursorIdx={cursorIdx}
        outline={outline}
        mapLabels={trackOverlays.segments ? mapLabels : null}
        pitLines={pitLines}
        boundaries={boundaries}
        sectors={trackOverlays.sectors ? sectors : null}
        segments={trackOverlays.segments ? segments : null}
        highlights={aiPanelOpen ? aiHighlights : null}
        showInputs={trackOverlays.inputs}
        showTrace={showTrace}
        showRaceLine={trackOverlays.racingLine && hasRacingLine}
        rotateWithCar={rotateWithCar}
        zoom={mapZoom}
      />
      {/* Weather widget (updates at cursor position) — bottom left by default, bottom right for the live dashboard */}
      {telemetry[cursorIdx]?.values["weather.air-temp"] != null && <WeatherWidget f1={telemetry[cursorIdx].values as never} position={weatherBottomRight ? "bottom-right" : "bottom-left"} />}

      {/* View toggles — top left */}
      <div className="absolute top-2 left-2 flex flex-wrap gap-1">
        <Button
          onClick={onRotateWithCarToggle}
          className={`px-2 py-1 text-app-micro uppercase tracking-wider font-semibold rounded border transition-colors ${
            rotateWithCar ? "bg-app-accent/15 border-app-accent/40 text-app-accent" : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
          }`}
        >
          {rotateWithCar ? m.overlay_follow() : m.overlay_fixed()}
        </Button>
        {!hideSteeringOverlay && onTrackOverlayChange && (
          <DropdownMenu
            align="left"
            trigger={
              <Button
                type="button"
                className={`px-2 py-1 text-app-micro uppercase tracking-wider font-semibold rounded border transition-colors ${
                  anyTrackOverlay ? "bg-app-accent/15 border-app-accent/40 text-app-accent" : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
                }`}
              >
                {m.overlay_overlay()}
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            }
            items={overlayItems}
          />
        )}
      </div>

      {/* Right side controls */}
      <div className="pointer-events-none absolute top-2 right-2 flex items-start gap-2">
        {rotateWithCar && (
          <div className="pointer-events-auto flex flex-col gap-1">
            <Button
              type="button"
              aria-label="Zoom in map"
              onClick={() => onMapZoomChange((z) => Math.min(z + 0.25, 4))}
              className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >
              +
            </Button>
            <Button
              type="button"
              aria-label="Zoom out map"
              onClick={() => onMapZoomChange((z) => Math.max(z - 0.25, 0.5))}
              className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >
              -
            </Button>
          </div>
        )}
        {currentFrame && <Compass yaw={Number(currentFrame.values["motion.yaw"]) || 0} />}
      </div>

      {/* Steering wheel + pedal bars — bottom right */}
    </div>
  );
}
