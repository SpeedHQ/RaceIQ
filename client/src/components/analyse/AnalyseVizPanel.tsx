import type { RefObject } from "react";
import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import type { useUnits } from "../../hooks/useUnits";
import { BodyAttitude } from "../BodyAttitude";
import { CarWireframe } from "../CarWireframe";
import { GForceCircle } from "../telemetry/GForceCircle";
import { Vitals2D } from "../telemetry/Vitals2D";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
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
}

export function AnalyseVizPanel({ vizMode, onVizModeChange, currentFrame, displayTelemetry, cursorRef, displayTelemetryRef, cursorIdx, lapLine, boundaries, units }: Props) {
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
        <Vitals2D />
      </TabsContent>

      <TabsContent value="3d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 p-2">
        <div className="relative min-h-0 w-full flex-1">
          {currentFrame && (
            <CarWireframe frame={currentFrame} telemetry={displayTelemetry} cursorRef={cursorRef} telemetryRef={displayTelemetryRef} cursorIdx={cursorIdx} outline={lapLine} boundaries={boundaries} tempLabel={units.tempLabel} />
          )}
          {currentFrame && (
            <div className="absolute bottom-1 left-1 opacity-80">
              <BodyAttitude frame={currentFrame} />
            </div>
          )}
          {currentFrame && (
            <div className="absolute bottom-1 left-1 opacity-90" style={{ bottom: "9rem" }}>
              <GForceCircle frame={currentFrame} />
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
