import { describe, expect, test } from "bun:test";
import { resolveAlignedCursor } from "../src/lib/comparison-utils";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const packet = (position: number): TelemetryPacket => ({ PositionX: position, PositionZ: 0 } as TelemetryPacket);

describe("comparison aligned cursor", () => {
  test("resolves each lap through its aligned source index", () => {
    const telemetryA = [0, 50, 75, 100].map(packet);
    const telemetryB = [0, 50, 55, 75, 100].map(packet);
    const cursor = resolveAlignedCursor(telemetryA, telemetryB, [0, 50, 75, 100], [0, 1, 2, 3], [0, 1, 3, 4], 75);
    expect(cursor).toEqual({ gridIndex: 2, packetA: telemetryA[2], packetB: telemetryB[3] });
  });

  test("returns null for empty cursor and does not substitute invalid indices", () => {
    expect(resolveAlignedCursor([], [], [], [], [], null)).toBeNull();
    const cursor = resolveAlignedCursor([packet(0)], [packet(0)], [0], [4], [0], 0);
    expect(cursor?.packetA).toBeNull();
    expect(cursor?.packetB).not.toBeNull();
  });
});
