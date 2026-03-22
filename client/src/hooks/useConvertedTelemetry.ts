import { useMemo } from "react";
import type { TelemetryPacket } from "@shared/types";
import { convertPackets, type DisplayPacket } from "../lib/convert-packet";
import { useSettings } from "./queries";

/**
 * Convert an array of historical telemetry packets once, memoized on unit changes.
 * Returns DisplayPacket[] with Display* fields pre-computed.
 */
export function useConvertedTelemetry(packets: TelemetryPacket[]): DisplayPacket[] {
  const { displaySettings } = useSettings();
  return useMemo(
    () => convertPackets(packets, displaySettings.speedUnit, displaySettings.temperatureUnit),
    [packets, displaySettings.speedUnit, displaySettings.temperatureUnit]
  );
}
