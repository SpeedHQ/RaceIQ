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
  const su = displaySettings.unit === "metric" ? "kmh" as const : "mph" as const;
  const tu = displaySettings.unit === "metric" ? "C" as const : "F" as const;
  return useMemo(
    () => convertPackets(packets, su, tu),
    [packets, su, tu]
  );
}
