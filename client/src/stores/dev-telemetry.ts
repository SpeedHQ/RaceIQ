import { createStore, useSelector, type StoreActionMap } from "@tanstack/react-store";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
export interface DevTelemetryState { subscriptionWanted: boolean; subscribed: boolean; error: "not-available" | "invalid-message" | null; packet: TelemetryPacket | null }
export interface DevTelemetryActions extends StoreActionMap { setSubscriptionWanted: (wanted: boolean) => void; setSubscription: (subscribed: boolean, error?: DevTelemetryState["error"]) => void; setPacket: (packet: TelemetryPacket | null) => void; clear: () => void }
const initialDevTelemetryState: DevTelemetryState = { subscriptionWanted: false, subscribed: false, error: null, packet: null };
export const devTelemetryStore = createStore(initialDevTelemetryState, (store): DevTelemetryActions => ({
  setSubscriptionWanted: (subscriptionWanted) => store.setState((state) => ({ ...state, subscriptionWanted })),
  setSubscription: (subscribed, error = null) => store.setState((state) => ({ ...state, subscribed, error })),
  setPacket: (packet) => store.setState((state) => ({ ...state, packet })),
  clear: () => store.setState((state) => ({ ...state, subscribed: false, error: null, packet: null })),
}));
export function useDevTelemetryStore<T>(selector: (state: DevTelemetryState) => T): T { return useSelector(devTelemetryStore, selector, { compare: Object.is }); }
