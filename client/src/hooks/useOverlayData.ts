import { useEffect, useState } from "react";
import { useTelemetryStore } from "@/stores/telemetry";
import { projectOverlayData, type OverlayData } from "@/lib/streaming-data";
import type { OverlayConfig } from "@/lib/streaming-config";

export function useOverlayData(config: OverlayConfig): OverlayData {
  const schema = useTelemetryStore((state) => state.telemetrySchema);
  const frame = useTelemetryStore((state) => state.telemetryFrame);
  const view = useTelemetryStore((state) => state.telemetryView);
  const connected = useTelemetryStore((state) => state.connected);
  const identity = frame ? `${frame.streamId}\u0000${frame.sessionId ?? "null"}\u0000${frame.sequence}` : "";
  const [arrival, setArrival] = useState<{ identity: string; at: number }>(() => ({ identity: "", at: 0 }));
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!identity) {
      setArrival({ identity: "", at: 0 });
      return;
    }
    setArrival((previous) => previous.identity === identity ? previous : { identity, at: performance.now() });
  }, [identity]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const matching = !!schema && !!frame && !!view && schema.schemaId === frame.schemaId &&
    view.streamId === frame.streamId && view.sessionId === frame.sessionId && view.sequence === frame.sequence;
  const matchingArrival = matching && arrival.identity === identity;
  const ageMs = matchingArrival ? Math.max(0, now - arrival.at) : 0;
  return projectOverlayData(schema, frame, matchingArrival ? view : null, connected, ageMs, config);
}
