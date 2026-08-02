import type { TelemetryPacket } from "@shared/types";
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
import type { DisplayPacket } from "../../lib/convert-packet";
import { m } from "../../paraglide/messages";
import type { AnalysisHighlight } from "../AiPanel";
import { AnalyseSegmentList } from "./AnalyseSegmentList";
import type { Point, SectorBoundaries, TrackMapHandle, TrackMapLabel } from "./AnalyseTrackMap";
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
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    },
    [],
  );
  const responsiveSizeVars = {
    "--analyse-top-height": `min(${topHeight}px, max(15.625rem, calc(100dvh - 18rem)))`,
    "--analyse-left-width": `clamp(3.75rem, ${leftColWidth}px, min(12rem, calc(100cqw - 29.25rem)))`,
    "--analyse-right-width": `clamp(12.5rem, ${rightColWidth}px, calc(100cqw - var(--analyse-left-width) - 16.75rem))`,
  } as CSSProperties;

  return (
    <div className="flex shrink-0 flex-col overflow-visible @5xl/workspace:h-(--analyse-top-height) @5xl/workspace:flex-row @5xl/workspace:overflow-hidden" style={responsiveSizeVars}>
      {/* Segment table + legend */}
      <div className="h-48 w-full shrink-0 overflow-y-auto border-b border-app-border p-2 @5xl/workspace:h-full @5xl/workspace:w-(--analyse-left-width) @5xl/workspace:border-r @5xl/workspace:border-b-0">
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
      <button
        type="button"
        aria-label="Resize segment panel"
        className="hidden w-1.5 shrink-0 cursor-col-resize bg-app-border transition-colors hover:bg-app-accent/40 @5xl/workspace:block"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const delta = event.key === "ArrowLeft" ? -16 : 16;
            onLeftResize(Math.max(60, Math.min(800, leftColWidth + delta)));
          }
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          resizeCleanupRef.current?.();
          const startX = e.clientX;
          const startW = leftColWidth;
          const onMove = (ev: MouseEvent) => {
            onLeftResize(Math.max(60, Math.min(800, startW + ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            resizeCleanupRef.current = null;
          };
          const cleanup = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          resizeCleanupRef.current = cleanup;
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />

      {/* Track map */}
      <div className="h-[28rem] w-full min-w-0 border-b border-app-border @5xl/workspace:h-full @5xl/workspace:flex-1 @5xl/workspace:border-r @5xl/workspace:border-b-0">
        <AnalyseTrackPanel
          telemetry={telemetry}
          cursorIdx={cursorIdx}
          outline={outline}
          mapLabels={mapLabels}
          boundaries={boundaries}
          sectors={sectors}
          segments={segments}
          currentPacket={currentPacket}
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
      <button
        type="button"
        aria-label="Resize visualization panel"
        className="hidden w-1.5 shrink-0 cursor-col-resize bg-app-border transition-colors hover:bg-app-accent/40 @5xl/workspace:block"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const delta = event.key === "ArrowLeft" ? 16 : -16;
            onRightResize(Math.max(200, rightColWidth + delta));
          }
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          resizeCleanupRef.current?.();
          const startX = e.clientX;
          const startW = rightColWidth;
          const onMove = (ev: MouseEvent) => {
            onRightResize(Math.max(200, startW - (ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            resizeCleanupRef.current = null;
          };
          const cleanup = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          resizeCleanupRef.current = cleanup;
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />

      {/* Rev meter + Steering wheel + Tire diagram */}
      <AnalyseVizPanel
        vizMode={vizMode}
        onVizModeChange={onVizModeChange}
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
