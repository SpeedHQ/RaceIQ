import { describe, expect, test } from "bun:test";
import { SourceSequenceTracker } from "../../shared/telemetry/source-sequence";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { packet } from "../support/telemetry/resolver";

function iracingPacket(sessionTick: number, timestampMs: number): TelemetryPacket {
  return packet("iracing", {
    TimestampMS: timestampMs,
    iracing: { sessionTick } as TelemetryPacket["iracing"],
  });
}

describe("source sequence tracking", () => {
  test("retains native gaps, duplicates, and out-of-order boundaries", () => {
    const tracker = new SourceSequenceTracker();
    for (const sample of [
      iracingPacket(1, 1_000),
      iracingPacket(2, 1_050),
      iracingPacket(5, 1_200),
      iracingPacket(5, 1_200),
      iracingPacket(4, 1_150),
      iracingPacket(6, 1_250),
    ]) {
      tracker.observe(sample);
    }

    const result = tracker.finalize();
    expect(result.summary).toMatchObject({
      countMethod: "native-sequence",
      observedCount: 6,
      expectedCount: 8,
      totalMissingCount: 2,
      largestContiguousGapMs: 150,
    });
    expect(result.gaps).toEqual([
      expect.objectContaining({
        sourceSequenceFamily: "iracing-session-tick",
        previousSequence: 2,
        currentSequence: 5,
        missingCount: 2,
      }),
    ]);
    expect(result.duplicates).toEqual([
      expect.objectContaining({
        sourceSequenceFamily: "iracing-session-tick",
        previousSequence: 5,
        currentSequence: 5,
      }),
    ]);
    expect(result.outOfOrder).toEqual([
      expect.objectContaining({
        sourceSequenceFamily: "iracing-session-tick",
        previousSequence: 5,
        currentSequence: 4,
      }),
    ]);
  });

  test("reconnect seeds next native and timestamp observations", () => {
    const tracker = new SourceSequenceTracker();
    tracker.observe(iracingPacket(10, 1_000));
    tracker.observe(iracingPacket(11, 1_050));
    tracker.markDiscontinuity();
    tracker.observe(iracingPacket(1, 100));
    tracker.observe(iracingPacket(2, 150));

    expect(tracker.finalize()).toMatchObject({
      summary: {
        countMethod: "native-sequence",
        observedCount: 4,
        expectedCount: 4,
        totalMissingCount: 0,
      },
      gaps: [],
      duplicates: [],
      outOfOrder: [],
    });
  });

  test("tracks F1 packet families independently", () => {
    const tracker = new SourceSequenceTracker();
    const f1Packet = (overallFrameIdentifier: number, packetId: number, timestampMs: number) =>
      packet("f1-2025", {
        TimestampMS: timestampMs,
        f1: { overallFrameIdentifier, packetId } as TelemetryPacket["f1"],
      });

    tracker.observe(f1Packet(1, 0, 1_000));
    tracker.observe(f1Packet(1, 1, 1_000));
    tracker.observe(f1Packet(2, 0, 1_050));
    tracker.observe(f1Packet(2, 1, 1_050));
    tracker.observe(f1Packet(2, 1, 1_050));

    expect(tracker.finalize().duplicates).toEqual([
      expect.objectContaining({
        sourceSequenceFamily: "f1-packet-1",
        previousSequence: 2,
        currentSequence: 2,
      }),
    ]);
  });

  test("falls back to timestamp gaps without native coordinates", () => {
    const tracker = new SourceSequenceTracker();
    for (const timestampMs of [1_000, 1_050, 1_200, 1_250]) {
      tracker.observe(packet("fm-2023", { TimestampMS: timestampMs }));
    }

    expect(tracker.finalize()).toMatchObject({
      summary: {
        countMethod: "timestamp-estimate",
        observedCount: 4,
        expectedCount: 6,
        totalMissingCount: 2,
        largestContiguousGapMs: 150,
      },
      gaps: [
        {
          sourceSequenceFamily: null,
          previousSequence: null,
          currentSequence: null,
          previousSourceTimeMs: 1_050,
          currentSourceTimeMs: 1_200,
          previousObservationIndex: 1,
          currentObservationIndex: 2,
          durationMs: 150,
          missingCount: 2,
          countMethod: "timestamp-estimate",
        },
      ],
      duplicates: [],
      outOfOrder: [],
    });
  });

  test("uses Kunos physics coordinate once per canonical packet", () => {
    const tracker = new SourceSequenceTracker();
    for (let index = 0; index < 4; index += 1) {
      tracker.observe(
        packet("acc", {
          TimestampMS: 1_000 + index * 50,
          acc: {
            physicsPacketId: (index + 1) * 3,
            graphicsPacketId: Math.floor(index / 2) + 1,
          } as TelemetryPacket["acc"],
        }),
      );
    }

    expect(tracker.finalize()).toMatchObject({
      summary: {
        countMethod: "native-sequence",
        observedCount: 4,
        expectedCount: 4,
        totalMissingCount: 0,
      },
      gaps: [],
      duplicates: [],
      outOfOrder: [],
    });
  });
});
