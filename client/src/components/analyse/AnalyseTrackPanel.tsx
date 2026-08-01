import type { TelemetryPacket } from "@shared/types";
import type { RefObject } from "react";
import { m } from "../../paraglide/messages";
import type { AnalysisHighlight } from "../AiPanel";
import { Compass } from "../Compass";
import { AnalyseSteeringOverlay } from "./AnalyseSteeringOverlay";
import { AnalyseTrackMap, type Point, type SectorBoundaries, type TrackMapHandle, type TrackMapLabel } from "./AnalyseTrackMap";
import { WeatherWidget } from "./WeatherWidget";

interface AnalyseTrackPanelProps {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: Point[] | null;
  mapLabels?: TrackMapLabel[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boundaries: any;
  sectors: SectorBoundaries | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  currentPacket: TelemetryPacket | null;

  aiPanelOpen?: boolean;
  aiHighlights?: AnalysisHighlight[] | null;

  rotateWithCar: boolean;
  trackOverlay: "none" | "inputs" | "segments" | "sectors";
  mapZoom: number;
  /** Live view passes false to draw only track edges, not the driving line. */
  showTrace?: boolean;
  onRotateWithCarToggle: () => void;
  onTrackOverlayCycle: () => void;
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
  telemetry,
  cursorIdx,
  outline,
  mapLabels,
  boundaries,
  sectors,
  segments,
  currentPacket,
  aiPanelOpen,
  aiHighlights,
  rotateWithCar,
  trackOverlay,
  mapZoom,
  showTrace,
  onRotateWithCarToggle,
  onTrackOverlayCycle,
  onMapZoomChange,
  trackMapRef,
  hideSteeringOverlay,
  weatherBottomRight,
}: AnalyseTrackPanelProps) {
  return (
    <div
      className="relative h-full min-w-0 bg-app-bg p-2"
      onWheel={(e) => {
        if (!rotateWithCar) return;
        e.preventDefault();
        onMapZoomChange((z) => Math.max(0.5, Math.min(4, z - e.deltaY * 0.001)));
      }}
    >
      <AnalyseTrackMap
        ref={trackMapRef}
        telemetry={telemetry}
        cursorIdx={cursorIdx}
        outline={outline}
        mapLabels={trackOverlay === "segments" ? mapLabels : null}
        boundaries={boundaries}
        sectors={trackOverlay === "sectors" ? sectors : null}
        segments={trackOverlay === "segments" ? segments : null}
        highlights={aiPanelOpen ? aiHighlights : null}
        showInputs={trackOverlay === "inputs"}
        showTrace={showTrace}
        rotateWithCar={rotateWithCar}
        zoom={mapZoom}
      />
      {/* Weather widget (updates at cursor position) — bottom left by default, bottom right for the live dashboard */}
      {telemetry[cursorIdx]?.f1 && <WeatherWidget f1={telemetry[cursorIdx].f1!} position={weatherBottomRight ? "bottom-right" : "bottom-left"} />}

      {/* View toggles — top left */}
      <div className="absolute top-2 left-2 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={onRotateWithCarToggle}
          className={`px-2 py-1 text-app-micro uppercase tracking-wider font-semibold rounded border transition-colors ${
            rotateWithCar ? "bg-app-accent/15 border-app-accent/40 text-app-accent" : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
          }`}
        >
          {rotateWithCar ? m.overlay_follow() : m.overlay_fixed()}
        </button>
        {!hideSteeringOverlay && (
          <button
            type="button"
            onClick={onTrackOverlayCycle}
            className={`px-2 py-1 text-app-micro uppercase tracking-wider font-semibold rounded border transition-colors ${
              trackOverlay !== "none" ? "bg-app-accent/15 border-app-accent/40 text-app-accent" : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
            }`}
          >
            {trackOverlay === "none" ? m.overlay_overlay() : trackOverlay === "inputs" ? m.overlay_inputs() : trackOverlay === "segments" ? m.overlay_segments() : m.overlay_sectors()}
          </button>
        )}
      </div>

      {/* Right side controls */}
      <div className="absolute top-2 right-2 flex items-start gap-2">
        {rotateWithCar && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onMapZoomChange((z) => Math.min(z + 0.25, 4))}
              className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => onMapZoomChange((z) => Math.max(z - 0.25, 0.5))}
              className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >
              -
            </button>
          </div>
        )}
        {currentPacket && <Compass yaw={currentPacket.Yaw} />}
      </div>

      {/* Steering wheel + pedal bars — bottom right */}
      {!hideSteeringOverlay && currentPacket && <AnalyseSteeringOverlay packet={currentPacket} />}
    </div>
  );
}
