import { create } from "zustand";
import type { TelemetryPacket } from "@shared/types";
import { convertPacket, type DisplayPacket } from "../lib/convert-packet";

export interface DisplaySettings {
  unit: "metric" | "imperial";
  tireTempCelsiusThresholds: { cold: number; warm: number; hot: number };
  tireHealthThresholds: { values: number[] };
  suspensionThresholds: { values: number[] };
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  unit: "metric",
  tireTempCelsiusThresholds: { cold: 65, warm: 105, hot: 138 },
  tireHealthThresholds: { values: [20, 40, 60, 80] },
  suspensionThresholds: { values: [25, 65, 85] },
};

interface TelemetryState {
  connected: boolean;
  /** Raw packet from WebSocket (unchanged, for calculations) */
  rawPacket: TelemetryPacket | null;
  /** Display-converted packet (speed/temp in user units) */
  packet: DisplayPacket | null;
  packetsPerSec: number;
  /** Current unit system */
  unitSystem: "metric" | "imperial";
  setConnected: (connected: boolean) => void;
  setPacket: (packet: TelemetryPacket) => void;
  clearPacket: () => void;
  setPacketsPerSec: (pps: number) => void;
  /** Update unit system — re-converts current packet */
  setUnitSystem: (unit: "metric" | "imperial") => void;
}

function speedUnit(u: "metric" | "imperial") { return u === "metric" ? "kmh" as const : "mph" as const; }
function tempUnit(u: "metric" | "imperial") { return u === "metric" ? "C" as const : "F" as const; }

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  connected: false,
  rawPacket: null,
  packet: null,
  packetsPerSec: 0,
  unitSystem: "metric",
  setConnected: (connected) => set({ connected }),
  setPacket: (raw) => {
    const { unitSystem } = get();
    set({
      rawPacket: raw,
      packet: convertPacket(raw, speedUnit(unitSystem), tempUnit(unitSystem)),
    });
  },
  clearPacket: () => set({ rawPacket: null, packet: null }),
  setPacketsPerSec: (packetsPerSec) => set({ packetsPerSec }),
  setUnitSystem: (unit) => {
    const { rawPacket } = get();
    set({
      unitSystem: unit,
      packet: rawPacket ? convertPacket(rawPacket, speedUnit(unit), tempUnit(unit)) : null,
    });
  },
}));
