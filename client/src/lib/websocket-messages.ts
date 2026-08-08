import { isDevTelemetryPacketMessageV1, isDevTelemetrySubscriptionMessageV1, isLiveTelemetryFrameMessageV1, isLiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import { useDevTelemetryStore } from "../stores/dev-telemetry";
import { useTelemetryStore } from "../stores/telemetry";

export function handleWebSocketMessage(data: unknown): boolean {
  if (isLiveTelemetrySchemaMessageV1(data)) {
    useTelemetryStore.getState().setTelemetrySchema(data);
    return false;
  }
  const schema = useTelemetryStore.getState().telemetrySchema;
  if (isLiveTelemetryFrameMessageV1(data, schema ?? undefined)) {
    useTelemetryStore.getState().setTelemetryFrame(data);
    return true;
  }
  if (isDevTelemetrySubscriptionMessageV1(data)) {
    useDevTelemetryStore.getState().setSubscription(data.subscribed, data.error ?? null);
    return false;
  }
  if (isDevTelemetryPacketMessageV1(data)) {
    useDevTelemetryStore.getState().setPacket(data.packet);
  }
  return false;
}
