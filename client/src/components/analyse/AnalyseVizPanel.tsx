import type { SceneRuntime, SceneSource } from "../wireframe/SceneRuntime";
import type { GameId } from "@shared/games/ids";
import { memo, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import { BodyAttitude } from "../BodyAttitude";
import { CarWireframe } from "../CarWireframe";
import { GForceCircle } from "../telemetry/GForceCircle";
import { TireDiagram } from "../telemetry/TireDiagram";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import type { Point, SemanticAnalysisFrame, TrackMapBoundaries } from "./track-map/types";
import { alignTrackBoundariesToPositions } from "./track-map/path";

interface Props {
  onVizModeChange: (mode: "2d" | "3d") => void;
  vizMode: "2d" | "3d";
  currentFrame: SemanticAnalysisFrame | null;
  semanticFrames: SemanticAnalysisFrame[];
  cursorRef: RefObject<number>;
  displayTelemetryRef: RefObject<SemanticAnalysisFrame[]>;
  cursorIdx: number;
  lapLine: Point[] | null;
  boundaries: TrackMapBoundaries | null;
  units: ReturnType<typeof useUnits>;
  gameId?: GameId;
  lmuCarClass?: string;
  sceneSource: SceneSource;
  onRuntime?: (runtime: SceneRuntime | null) => void;
}
function areAnalyseVizPropsEqual(previous: Props, next: Props): boolean {
  return (
    previous.vizMode === next.vizMode &&
    previous.onVizModeChange === next.onVizModeChange &&
    previous.semanticFrames === next.semanticFrames &&
    previous.cursorRef === next.cursorRef &&
    previous.displayTelemetryRef === next.displayTelemetryRef &&
    previous.lapLine === next.lapLine &&
    previous.boundaries === next.boundaries &&
    previous.units === next.units &&
    previous.lmuCarClass === next.lmuCarClass &&
    previous.gameId === next.gameId &&
    previous.sceneSource === next.sceneSource &&
    previous.onRuntime === next.onRuntime
  );
}

export const AnalyseVizPanel = memo(function AnalyseVizPanel({
  vizMode,
  onVizModeChange,
  currentFrame,
  semanticFrames,
  cursorRef,
  displayTelemetryRef,
  cursorIdx,
  lapLine,
  boundaries,
  units,
  gameId,
  lmuCarClass,
  sceneSource,
  onRuntime,
}: Props) {
  const sceneCursorIdx = useRef(cursorIdx).current;
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
  const visualFrame = displayTelemetryRef.current[visualCursorIdx] ?? semanticFrames[visualCursorIdx] ?? currentFrame;
  const sceneBoundaries = useMemo(
    () => gameId === "lmu" && lapLine ? alignTrackBoundariesToPositions(boundaries, lapLine) : boundaries,
    [boundaries, gameId, lapLine],
  );

  return (
    <Tabs
      value={vizMode}
      onValueChange={(value) => {
        if (value === "2d" || value === "3d") onVizModeChange(value);
      }}
      className="flex h-[30rem] w-full shrink-0 flex-col items-center justify-start overflow-hidden border-b border-app-border @5xl/workspace:h-full @5xl/workspace:w-(--analyse-right-width) @5xl/workspace:border-r @5xl/workspace:border-b-0"
    >
      <TabsList variant="underline" className="w-full shrink-0">
        <TabsTrigger value="2d" className="flex-1">
          2D
        </TabsTrigger>
        <TabsTrigger value="3d" className="flex-1">
          3D
        </TabsTrigger>
      </TabsList>

      <TabsContent value="2d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto p-2">
        {visualFrame && gameId && <TireDiagram frame={visualFrame} gameId={gameId} />}
      </TabsContent>

      <TabsContent value="3d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto p-2">
        <div className="relative min-h-0 w-full flex-1">
          {visualFrame && (
            <CarWireframe
              gameId={gameId}
              lmuCarClass={lmuCarClass}
              frame={semanticFrames[0]}
              source={sceneSource}
              onRuntime={onRuntime}
              telemetry={semanticFrames}
              cursorIdx={sceneCursorIdx}
              outline={lapLine}
              boundaries={sceneBoundaries}
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
