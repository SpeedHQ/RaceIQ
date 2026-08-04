import type { RefObject } from "react";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import type { useUnits } from "../../hooks/useUnits";
import type { DisplayPacket } from "../../lib/convert-packet";
import { BodyAttitude } from "../BodyAttitude";
import { CarWireframe } from "../CarWireframe";
import { GForceCircle } from "../telemetry/GForceCircle";
import { Vitals2D } from "../telemetry/Vitals2D";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import type { Point } from "./track-map/types";

interface Props {
  vizMode: "2d" | "3d";
  onVizModeChange: (mode: "2d" | "3d") => void;
  currentPacket: TelemetryPacket | null;
  currentDisplayPacket: DisplayPacket | null;
  displayTelemetry: DisplayPacket[];
  cursorRef: RefObject<number>;
  displayTelemetryRef: RefObject<DisplayPacket[]>;
  cursorIdx: number;
  lapLine: Point[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boundaries: any;
  units: ReturnType<typeof useUnits>;
}

export function AnalyseVizPanel({ vizMode, onVizModeChange, currentPacket, currentDisplayPacket, displayTelemetry, cursorRef, displayTelemetryRef, cursorIdx, lapLine, boundaries, units }: Props) {
  return (
    <Tabs
      value={vizMode}
      onValueChange={(value) => {
        if (value === "2d" || value === "3d") onVizModeChange(value);
      }}
      className="flex h-[30rem] w-full shrink-0 flex-col items-center justify-start overflow-y-auto border-b border-app-border @5xl/workspace:h-full @5xl/workspace:w-(--analyse-right-width) @5xl/workspace:border-r @5xl/workspace:border-b-0"
    >
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="2d" className="flex-1">
          2D
        </TabsTrigger>
        <TabsTrigger value="3d" className="flex-1">
          3D
        </TabsTrigger>
      </TabsList>

      <TabsContent value="2d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 p-2">
        <Vitals2D packet={currentPacket} />
      </TabsContent>

      <TabsContent value="3d" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 p-2">
        <div className="relative min-h-0 w-full flex-1">
          {currentDisplayPacket && (
            <CarWireframe
              packet={currentDisplayPacket}
              telemetry={displayTelemetry}
              cursorRef={cursorRef}
              telemetryRef={displayTelemetryRef}
              cursorIdx={cursorIdx}
              outline={lapLine}
              boundaries={boundaries}
              carOrdinal={currentDisplayPacket.CarOrdinal}
              tempLabel={units.tempLabel}
            />
          )}
          {currentPacket && (
            <div className="absolute bottom-1 left-1 opacity-80">
              <BodyAttitude packet={currentPacket} />
            </div>
          )}
          {currentPacket && (
            <div className="absolute bottom-1 left-1 opacity-90" style={{ bottom: "9rem" }}>
              <GForceCircle packet={currentPacket} />
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
