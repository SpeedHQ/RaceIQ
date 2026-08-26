import { RawTelemetry } from "../RawTelemetry";
import { devTelemetryStore, useDevTelemetryStore } from "../../stores/dev-telemetry";

export function DevTelemetryPanel() {
  const wanted = useDevTelemetryStore((s) => s.subscriptionWanted);
  const subscribed = useDevTelemetryStore((s) => s.subscribed);
  const error = useDevTelemetryStore((s) => s.error);
  const packet = useDevTelemetryStore((s) => s.packet);
  const setWanted = devTelemetryStore.actions.setSubscriptionWanted;
  const status = error === "not-available" ? "Denied" : error === "invalid-message" ? "Error" : subscribed ? "Active" : wanted ? "Pending" : "Disconnected";
  return <div className="flex h-full flex-col overflow-hidden"><div className="flex items-center justify-between border-b border-app-border p-4"><div><h2 className="font-semibold">Native Telemetry</h2><span className="text-xs text-app-text-muted">{status}</span></div><button type="button" className="rounded border border-app-border px-3 py-1 text-sm" onClick={() => setWanted(!wanted)}>{wanted ? "Stop" : "Start"}</button></div><div className="min-h-0 flex-1"><RawTelemetry packet={packet} /></div></div>;
}
