import type { RefObject } from "react";
import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import { Compass } from "../Compass";
import { WeatherWidget } from "./WeatherWidget";
import { AnalyseTrackMap, type TrackMapHandle, type Point } from "./AnalyseTrackMap";
import { AnalyseSegmentList } from "./AnalyseSegmentList";
import { AnalyseSteeringOverlay } from "./AnalyseSteeringOverlay";
import { AnalyseVizPanel } from "./AnalyseVizPanel";
import type { AnalysisHighlight } from "../AiPanel";

interface AnalyseTopSectionProps {
  // Layout
  topHeight: number;
  leftColWidth: number;
  rightColWidth: number;
  onLeftResize: (width: number) => void;
  onRightResize: (width: number) => void;

  // Data
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: Point[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boundaries: any;
  sectors: { s1End: number; s2End: number } | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  currentPacket: TelemetryPacket | null;
  currentDisplayPacket: DisplayPacket | null;
  displayTelemetry: DisplayPacket[];
  lapLine: Point[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  units: any;

  // AI highlights
  aiPanelOpen: boolean;
  aiHighlights: AnalysisHighlight[] | null;

  // View toggles
  rotateWithCar: boolean;
  trackOverlay: "none" | "inputs" | "segments" | "sectors";
  mapZoom: number;
  onRotateWithCarToggle: () => void;
  onTrackOverlayCycle: () => void;
  onMapZoomChange: (updater: (z: number) => number) => void;

  // Viz
  vizMode: "2d" | "3d";
  onVizModeChange: (mode: "2d" | "3d") => void;

  // Refs
  trackMapRef: RefObject<TrackMapHandle | null>;
  cursorRef: RefObject<number>;
  displayTelemetryRef: RefObject<DisplayPacket[]>;
}

export function AnalyseTopSection({
  topHeight,
  leftColWidth,
  rightColWidth,
  onLeftResize,
  onRightResize,
  telemetry,
  cursorIdx,
  outline,
  boundaries,
  sectors,
  segments,
  currentPacket,
  currentDisplayPacket,
  displayTelemetry,
  lapLine,
  units,
  aiPanelOpen,
  aiHighlights,
  rotateWithCar,
  trackOverlay,
  mapZoom,
  onRotateWithCarToggle,
  onTrackOverlayCycle,
  onMapZoomChange,
  vizMode,
  onVizModeChange,
  trackMapRef,
  cursorRef,
  displayTelemetryRef,
}: AnalyseTopSectionProps) {
  return (
    <div className="flex shrink-0 overflow-hidden" style={{ height: topHeight }}>
      {/* Segment table + legend */}
      <div className="border-r border-app-border overflow-y-auto p-2 shrink-0" style={{ height: "100%", width: leftColWidth }}>
        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 mb-2 pb-2 border-b border-app-border">
          <div className="flex items-center gap-1">
            <div className="w-3 h-1.5 rounded-sm bg-amber-500" />
            <span className="text-[9px] text-app-text-muted">Corner</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-1.5 rounded-sm bg-blue-500" />
            <span className="text-[9px] text-app-text-muted">Straight</span>
          </div>
        </div>
        {/* Segment list */}
        <AnalyseSegmentList telemetry={telemetry} segments={segments} cursorIdx={cursorIdx} />
      </div>

      {/* Left resize handle */}
      <div
        className="w-1.5 shrink-0 cursor-col-resize bg-app-border hover:bg-app-accent/40 transition-colors"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = leftColWidth;
          const onMove = (ev: MouseEvent) => {
            onLeftResize(Math.max(60, Math.min(800, startW + ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />

      {/* Track map */}
      <div
        className="border-r border-app-border bg-app-bg p-2 relative flex-1 min-w-0"
        style={{ height: "100%" }}
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
          boundaries={boundaries}
          sectors={trackOverlay === "sectors" ? sectors : null}
          segments={trackOverlay === "segments" ? segments : null}
          highlights={aiPanelOpen ? aiHighlights : null}
          showInputs={trackOverlay === "inputs"}
          rotateWithCar={rotateWithCar}
          zoom={mapZoom}
          containerHeight={topHeight}
        />
        {/* Weather widget — top left (updates at cursor position) */}
        {telemetry[cursorIdx]?.f1 && <WeatherWidget f1={telemetry[cursorIdx].f1!} />}

        {/* View toggles — top left */}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          <button
            onClick={onRotateWithCarToggle}
            className={`px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
              rotateWithCar
                ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
                : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
            }`}
          >
            {rotateWithCar ? "Follow" : "Fixed"}
          </button>
          <button
            onClick={onTrackOverlayCycle}
            className={`px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
              trackOverlay !== "none"
                ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
                : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
            }`}
          >
            {trackOverlay === "none" ? "Overlay" : trackOverlay === "inputs" ? "Inputs" : trackOverlay === "segments" ? "Segments" : "Sectors"}
          </button>
        </div>

        {/* Right side controls */}
        <div className="absolute top-2 right-2 flex items-start gap-2">
          {rotateWithCar && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => onMapZoomChange((z) => Math.min(z + 0.25, 4))}
                className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >+</button>
              <button
                onClick={() => onMapZoomChange((z) => Math.max(z - 0.25, 0.5))}
                className="w-6 h-6 text-xs bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >-</button>
            </div>
          )}
          {currentPacket && <Compass yaw={currentPacket.Yaw} />}
        </div>

        {/* Steering wheel + pedal bars — bottom right */}
        {currentPacket && <AnalyseSteeringOverlay packet={currentPacket} />}
      </div>

      {/* Right resize handle */}
      <div
        className="w-1.5 shrink-0 cursor-col-resize bg-app-border hover:bg-app-accent/40 transition-colors"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = rightColWidth;
          const onMove = (ev: MouseEvent) => {
            onRightResize(Math.max(200, startW - (ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />

      {/* Rev meter + Steering wheel + Tire diagram */}
      <AnalyseVizPanel
        vizMode={vizMode}
        onVizModeChange={onVizModeChange}
        width={rightColWidth}
        currentPacket={currentPacket}
        currentDisplayPacket={currentDisplayPacket}
        displayTelemetry={displayTelemetry}
        cursorRef={cursorRef}
        displayTelemetryRef={displayTelemetryRef}
        cursorIdx={cursorIdx}
        lapLine={lapLine}
        boundaries={boundaries}
        units={units}
      />
    </div>
  );
}
