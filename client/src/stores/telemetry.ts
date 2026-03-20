import { create } from "zustand";
import type { TelemetryPacket } from "@shared/types";

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
  packet: TelemetryPacket | null;
  packetsPerSec: number;
  setConnected: (connected: boolean) => void;
  setPacket: (packet: TelemetryPacket) => void;
  setPacketsPerSec: (pps: number) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  connected: false,
  packet: null,
  packetsPerSec: 0,
  setConnected: (connected) => set({ connected }),
  setPacket: (packet) => set({ packet }),
  setPacketsPerSec: (packetsPerSec) => set({ packetsPerSec }),
}));
