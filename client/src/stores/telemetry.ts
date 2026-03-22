import { create } from "zustand";
import type { TelemetryPacket } from "@shared/types";
import { convertPacket, type DisplayPacket } from "../lib/convert-packet";

export interface DisplaySettings {
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: { cold: number; warm: number; hot: number };
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  temperatureUnit: "F",
  speedUnit: "mph",
  tireTemperatureThresholds: { cold: 150, warm: 220, hot: 280 },
};

interface TelemetryState {
  connected: boolean;
  /** Raw packet from WebSocket (unchanged, for calculations) */
  rawPacket: TelemetryPacket | null;
  /** Display-converted packet (speed/temp in user units) */
  packet: DisplayPacket | null;
  packetsPerSec: number;
  /** Current unit settings used for conversion */
  unitSettings: { speedUnit: "mph" | "kmh"; tempUnit: "F" | "C" };
  setConnected: (connected: boolean) => void;
  setPacket: (packet: TelemetryPacket) => void;
  setPacketsPerSec: (pps: number) => void;
  /** Update unit settings — re-converts current packet */
  setUnitSettings: (speedUnit: "mph" | "kmh", tempUnit: "F" | "C") => void;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  connected: false,
  rawPacket: null,
  packet: null,
  packetsPerSec: 0,
  unitSettings: { speedUnit: "mph", tempUnit: "F" },
  setConnected: (connected) => set({ connected }),
  setPacket: (raw) => {
    const { unitSettings } = get();
    set({
      rawPacket: raw,
      packet: convertPacket(raw, unitSettings.speedUnit, unitSettings.tempUnit),
    });
  },
  setPacketsPerSec: (packetsPerSec) => set({ packetsPerSec }),
  setUnitSettings: (speedUnit, tempUnit) => {
    const { rawPacket } = get();
    set({
      unitSettings: { speedUnit, tempUnit },
      packet: rawPacket ? convertPacket(rawPacket, speedUnit, tempUnit) : null,
    });
  },
}));
