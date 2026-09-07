import type { GameId } from "@shared/games/ids";
import { memo, type RefObject, useEffect, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import { BodyAttitude } from "../BodyAttitude";
import { CarWireframe } from "../CarWireframe";
import { GForceCircle } from "../telemetry/GForceCircle";
import { Vitals2D } from "../telemetry/Vitals2D";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import type { Point, TrackMapBoundaries } from "./track-map/types";

interface Props {
  onVizModeChange: (mode: "2d" | "3d") => void;
  vizMode: "2d" | "3d";
  currentFrame: SemanticAnalysisFrame | null;
  displayTelemetry: SemanticAnalysisFrame[];
  cursorRef: RefObject<number>;
  displayTelemetryRef: RefObject<SemanticAnalysisFrame[]>;
  cursorIdx: number;
  lapLine: Point[] | null;
  boundaries: TrackMapBoundaries | null;
  units: ReturnType<typeof useUnits>;
  gameId?: GameId;
}
function areAnalyseVizPropsEqual(previous: Props, next: Props): boolean {
  return (
    previous.vizMode === next.vizMode &&
    previous.onVizModeChange === next.onVizModeChange &&
    previous.displayTelemetry === next.displayTelemetry &&
    previous.cursorRef === next.cursorRef &&
    previous.displayTelemetryRef === next.displayTelemetryRef &&
    previous.lapLine === next.lapLine &&
    previous.boundaries === next.boundaries &&
    previous.units === next.units &&
    previous.gameId === next.gameId
  );
}

export const AnalyseVizPanel = memo(function AnalyseVizPanel({
  vizMode,
  onVizModeChange,
  currentFrame,
  displayTelemetry,
  cursorRef,
  displayTelemetryRef,
  cursorIdx,
  lapLine,
  boundaries,
  units,
  gameId,
}: Props) {
  const [visualCursorIdx, setVisualCursorIdx] = useState(cursorIdx);
  useEffect(() => {
    let animationFrame: number;
    const syncCursor = () => {
      const nextCursor = cursorRef.current;
      setVisualCursorIdx((current) => (current === nextCursor ? current : nextCursor));
      animationFrame = requestAnimationFrame(syncCursor);
    };
    animationFrame = requestAnimationFrame(syncCursor);
    return () => cancelAnimationFrame(animationFrame);
  }, [cursorRef]);
  const visualFrame = displayTelemetryRef.current[visualCursorIdx] ?? displayTelemetry[visualCursorIdx] ?? currentFrame;

  return (
    <Tabs
      value={vizMode}
      onValueChange={(value) => {
        if (value === "2d" || value === "3d") onVizModeChange(value);
      }}
      className="flex h-[30rem] w-full shrink-0 flex-col items-center justify-start overflow-y-auto border-b border-app-border @5xl/workspace:h-full @5xl/workspace:w-(--analyse-right-width) @5xl/workspace:border-r @5xl/workspace:border-b-0"
    >
      <TabsList variant="underline" className="w-full shrink-0">
        <TabsTrigger value="2d" className="flex-1">
          2D
        </TabsTrigger>
        <TabsTrigger value="3d" className="flex-1">
          3D
        </TabsTrigger>
      </TabsList>

      <TabsContent value="2d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 p-2">
        <Vitals2D frame={visualFrame ?? undefined} gameId={gameId} />
      </TabsContent>

      <TabsContent value="3d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 p-2">
        <div className="relative min-h-0 w-full flex-1">
          {visualFrame && (
            <CarWireframe
              gameId={gameId}
              frame={visualFrame}
              telemetry={displayTelemetry}
              cursorRef={cursorRef}
              telemetryRef={displayTelemetryRef}
              cursorIdx={visualCursorIdx}
              outline={lapLine}
              boundaries={boundaries}
              tempLabel={units.tempLabel}
            />
          )}
          {visualFrame && (
            <div className="absolute bottom-1 left-1 opacity-80">
              <BodyAttitude frame={visualFrame} />
            </div>
          )}
          {visualFrame && (
            <div className="absolute bottom-1 left-1 opacity-90" style={{ bottom: "9rem" }}>
              <GForceCircle frame={visualFrame} />
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}, areAnalyseVizPropsEqual);
