import type { TelemetryPacket } from "@shared/types";
import type { RefObject } from "react";
import type { useUnits } from "../../hooks/useUnits";
import type { DisplayPacket } from "../../lib/convert-packet";
import { BodyAttitude } from "../BodyAttitude";
import { CarWireframe } from "../CarWireframe";
import { GForceCircle } from "../telemetry/GForceCircle";
import { Vitals2D } from "../telemetry/Vitals2D";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import type { Point } from "./AnalyseTrackMap";

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
    <div className="flex h-[30rem] w-full shrink-0 flex-col items-center justify-start overflow-y-auto border-b border-app-border @5xl/workspace:h-full @5xl/workspace:w-(--analyse-right-width) @5xl/workspace:border-r @5xl/workspace:border-b-0">
      {/* Wheel panel tabs */}
      <div className="flex w-full border-b border-app-border shrink-0">
        <button
          type="button"
          onClick={() => onVizModeChange("2d")}
          className={`flex-1 py-1.5 text-app-caption uppercase tracking-wider font-semibold transition-colors ${
            vizMode === "2d" ? "text-app-text border-b-2 border-app-accent" : "text-app-text-muted hover:text-app-text"
          }`}
        >
          2D
        </TabsTrigger>
        <TabsTrigger value="3d" className="flex-1">
          3D
        </TabsTrigger>
      </TabsList>

      <div className="p-2 flex flex-col items-center gap-2 w-full flex-1 min-h-0">
        {vizMode === "2d" ? (
          <Vitals2D packet={currentPacket} />
        ) : (
          <div className="w-full flex-1 min-h-0 relative">
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
        )}
      </div>
    </div>
  );
}
