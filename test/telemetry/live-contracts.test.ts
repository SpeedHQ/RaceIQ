import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import {
  isDevTelemetryControlMessageV1,
  isDevTelemetryPacketMessageV1,
  isDevTelemetrySubscriptionMessageV1,
  isLiveTelemetryFrameMessageV1,
  isLiveTelemetrySchemaMessageV1,
  LIVE_TELEMETRY_PROTOCOL_VERSION,
  type LiveTelemetryFrameMessageV1,
  type LiveTelemetrySchemaMessageV1,
} from "../../shared/telemetry/live/contracts";

function roundTrip<T>(value: T): T {
  const encoded = JSON.stringify(value);
  expect(encoded).not.toContain("bigint");
  return JSON.parse(encoded) as T;
}

const schema: LiveTelemetrySchemaMessageV1 = {
  type: "telemetry-schema", protocolVersion: LIVE_TELEMETRY_PROTOCOL_VERSION, schemaId: "s1", simulator: "acc",
  catalogVersion: "c", catalogHash: "h", catalogSchemaVersion: "1", parserVersion: "p", resolverVersion: "r", derivationVersion: "d",
  definitions: [{ semanticId: "motion.speed", unit: "m/s", mappingStatus: "direct", schemaVersion: "1", limitations: [] }],
};
const frame: LiveTelemetryFrameMessageV1 = {
  type: "telemetry-frame", protocolVersion: 1, schemaId: "s1", streamId: "x", sessionId: 2, sequence: 3,
  observedAt: { domain: "session", milliseconds: 100 }, receivedAtMs: 200, values: [42], states: { 0: "stale" }, freshness: { 0: "unknown" }, context: {},
};

describe("live telemetry contracts", () => {
  test("round-trips schema and frame JSON", () => {
    expect(isLiveTelemetrySchemaMessageV1(roundTrip(schema))).toBe(true);
    expect(isLiveTelemetryFrameMessageV1(roundTrip(frame), schema)).toBe(true);
    expect(isLiveTelemetrySchemaMessageV1({ ...schema, definitions: [{ ...schema.definitions[0], mappingStatus: "bogus" }] })).toBe(false);
  });
  test("round-trips dev controls and subscription result", () => {
    expect(isDevTelemetryControlMessageV1(roundTrip({ type: "subscribe", channel: "dev-telemetry" }))).toBe(true);
    expect(isDevTelemetryControlMessageV1(roundTrip({ type: "unsubscribe", channel: "dev-telemetry" }))).toBe(true);
    expect(isDevTelemetrySubscriptionMessageV1(roundTrip({ type: "subscription", channel: "dev-telemetry", subscribed: true }))).toBe(true);
  });
  test("accepts native dev packet only with game and finite timestamp", () => {
    const packet = { gameId: "acc", TimestampMS: 10 } as unknown as TelemetryPacket;
    expect(isDevTelemetryPacketMessageV1(roundTrip({ type: "dev-telemetry", protocolVersion: 1, packet }))).toBe(true);
    expect(isDevTelemetryPacketMessageV1({ type: "dev-telemetry", protocolVersion: 2, packet })).toBe(false);
    expect(isDevTelemetryPacketMessageV1({ type: "dev-telemetry", protocolVersion: 1, packet: { TimestampMS: 10 } })).toBe(false);
  });
  test("rejects invalid frame discriminators", () => {
    expect(isLiveTelemetryFrameMessageV1({ ...frame, protocolVersion: 2 }, schema)).toBe(false);
    expect(isLiveTelemetryFrameMessageV1({ ...frame, sequence: Number.NaN }, schema)).toBe(false);
    expect(isLiveTelemetryFrameMessageV1({ ...frame, values: [] }, schema)).toBe(false);
    expect(isLiveTelemetryFrameMessageV1({ ...frame, states: { 0: "bogus" } }, schema)).toBe(false);
    expect(isLiveTelemetryFrameMessageV1({ ...frame, freshness: { 0: "fresh" } }, schema)).toBe(false);
  });
});
