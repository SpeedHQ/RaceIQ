import { create } from "zustand";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

type DevTelemetryState = {
  subscriptionWanted: boolean;
  subscribed: boolean;
  error: "not-available" | "invalid-message" | null;
  packet: TelemetryPacket | null;
  setSubscriptionWanted: (wanted: boolean) => void;
  setSubscription: (subscribed: boolean, error?: DevTelemetryState["error"]) => void;
  setPacket: (packet: TelemetryPacket | null) => void;
  clear: () => void;
};
export const useDevTelemetryStore = create<DevTelemetryState>((set) => ({
  subscriptionWanted: false, subscribed: false, error: null, packet: null,
  setSubscriptionWanted: (subscriptionWanted) => set({ subscriptionWanted }),
  setSubscription: (subscribed, error = null) => set({ subscribed, error }),
  setPacket: (packet) => set({ packet }),
  clear: () => set({ subscribed: false, error: null, packet: null }),
}));
