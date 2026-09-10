import { isDevTelemetryPacketMessageV1, isDevTelemetrySubscriptionMessageV1, isLiveTelemetryFrameMessageV1, isLiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import { devTelemetryStore, } from "../stores/dev-telemetry";
import { telemetryStore, } from "../stores/telemetry";

export function handleWebSocketMessage(data: unknown): boolean {
  if (isLiveTelemetrySchemaMessageV1(data)) {
    telemetryStore.actions.setTelemetrySchema(data);
    return false;
  }
  const schema = telemetryStore.get().telemetrySchema;
  if (isLiveTelemetryFrameMessageV1(data, schema ?? undefined)) {
    telemetryStore.actions.setTelemetryFrame(data);
    return true;
  }
  if (isDevTelemetrySubscriptionMessageV1(data)) {
    devTelemetryStore.actions.setSubscription(data.subscribed, data.error ?? null);
    return false;
  }
  if (isDevTelemetryPacketMessageV1(data)) {
    devTelemetryStore.actions.setPacket(data.packet);
  }
  return false;
}
