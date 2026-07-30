import type { TelemetryPacket } from "@shared/types";
import type { RefObject } from "react";
import type { DisplayPacket } from "../../lib/convert-packet";
import { m } from "../../paraglide/messages";
import type { AnalysisHighlight } from "../AiPanel";
import { AnalyseSegmentList } from "./AnalyseSegmentList";
import type {
  Point,
  SectorBoundaries,
  TrackMapLabel,
  TrackMapHandle,
} from "./AnalyseTrackMap";
import { AnalyseTrackPanel } from "./AnalyseTrackPanel";
import { AnalyseVizPanel } from "./AnalyseVizPanel";

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
  mapLabels?: TrackMapLabel[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boundaries: any;
  sectors: SectorBoundaries | null;
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
  mapLabels,
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
              <div className="w-3 h-1.5 rounded-sm bg-(--telemetry-ers-deployed)" />
            <span className="text-app-micro text-app-text-muted">{m.label_corner()}</span>
          </div>
          <div className="flex items-center gap-1">
              <div className="w-3 h-1.5 rounded-sm bg-(--telemetry-ers-store)" />
            <span className="text-app-micro text-app-text-muted">{m.analyse_straight()}</span>
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
      <div className="border-r border-app-border flex-1 min-w-0" style={{ height: "100%" }}>
        <AnalyseTrackPanel
          telemetry={telemetry}
          cursorIdx={cursorIdx}
          outline={outline}
          mapLabels={mapLabels}
          boundaries={boundaries}
          sectors={sectors}
          segments={segments}
          currentPacket={currentPacket}
          containerHeight={topHeight}
          aiPanelOpen={aiPanelOpen}
          aiHighlights={aiHighlights}
          rotateWithCar={rotateWithCar}
          trackOverlay={trackOverlay}
          mapZoom={mapZoom}
          onRotateWithCarToggle={onRotateWithCarToggle}
          onTrackOverlayCycle={onTrackOverlayCycle}
          onMapZoomChange={onMapZoomChange}
          trackMapRef={trackMapRef}
        />
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
