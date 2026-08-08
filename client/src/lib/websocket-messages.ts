import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import { isDevTelemetryPacketMessageV1, isDevTelemetrySubscriptionMessageV1, isLiveTelemetryFrameMessageV1, isLiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import { useDevTelemetryStore } from "../stores/dev-telemetry";
import { useTelemetryStore } from "../stores/telemetry";

export function handleWebSocketMessage(data: unknown): void {
  if (isLiveTelemetrySchemaMessageV1(data)) {
    useTelemetryStore.getState().setTelemetrySchema(data);
    return;
  }
  const schema = useTelemetryStore.getState().telemetrySchema;
  if (isLiveTelemetryFrameMessageV1(data, schema ?? undefined)) {
    useTelemetryStore.getState().setTelemetryFrame(data);
    return;
  }
  if (isDevTelemetrySubscriptionMessageV1(data)) {
    useDevTelemetryStore.getState().setSubscription(data.subscribed, data.error ?? null);
    return;
  }
  if (isDevTelemetryPacketMessageV1(data)) {
    useDevTelemetryStore.getState().setPacket(data.packet);
  }
}

export type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 };
