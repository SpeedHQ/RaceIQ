import type { RefObject } from "react";
import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import type { useUnits } from "../../hooks/useUnits";
import type { Point } from "./AnalyseTrackMap";
import { Vitals2D } from "../telemetry/Vitals2D";
import { GForceCircle } from "../telemetry/GForceCircle";
import { BodyAttitude } from "../BodyAttitude";
import { CarWireframe } from "../CarWireframe";

interface Props {
  vizMode: "2d" | "3d";
  onVizModeChange: (mode: "2d" | "3d") => void;
  width: number;
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

export function AnalyseVizPanel({
  vizMode,
  onVizModeChange,
  width,
  currentPacket,
  currentDisplayPacket,
  displayTelemetry,
  cursorRef,
  displayTelemetryRef,
  cursorIdx,
  lapLine,
  boundaries,
  units,
}: Props) {
  return (
    <div className="border-r border-app-border flex flex-col items-center justify-start overflow-y-auto shrink-0" style={{ width }}>
      {/* Wheel panel tabs */}
      <div className="flex w-full border-b border-app-border shrink-0">
        <button
          onClick={() => onVizModeChange("2d")}
          className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
            vizMode === "2d" ? "text-app-text border-b-2 border-app-accent" : "text-app-text-muted hover:text-app-text"
          }`}
        >
          2D
        </button>
        <button
          onClick={() => onVizModeChange("3d")}
          className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
            vizMode === "3d" ? "text-app-text border-b-2 border-app-accent" : "text-app-text-muted hover:text-app-text"
          }`}
        >
          3D
        </button>
      </div>

      <div className="p-2 flex flex-col items-center gap-2 w-full flex-1 min-h-0">
        {vizMode === "2d" ? (
          <>
            <Vitals2D packet={currentPacket} />
          </>
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
