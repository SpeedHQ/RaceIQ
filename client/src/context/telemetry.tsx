import { createContext, useContext } from "react";
import type { TelemetryPacket } from "@shared/types";

interface TelemetryContextValue {
  connected: boolean;
  packet: TelemetryPacket | null;
  packetsPerSec: number;
}

export const TelemetryContext = createContext<TelemetryContextValue>({
  connected: false,
  packet: null,
  packetsPerSec: 0,
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}
