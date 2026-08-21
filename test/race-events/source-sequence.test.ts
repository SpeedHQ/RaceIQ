import { describe, expect, test } from "bun:test";

import { SourceSequenceTracker } from "../../shared/telemetry/source-sequence";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { packet } from "../support/telemetry/resolver";

describe("source sequence tracker", () => {
  test("reports native duplicate and out-of-order boundaries immediately", () => {
    const tracker = new SourceSequenceTracker();
    tracker.observe(
      packet("iracing", {
        TimestampMS: 10,
        iracing: { sessionTick: 1 } as never,
      }),
    );
    tracker.observe(
      packet("iracing", {
        TimestampMS: 20,
        iracing: { sessionTick: 2 } as never,
      }),
    );
    const duplicate = tracker.observe(
      packet("iracing", {
        TimestampMS: 21,
        iracing: { sessionTick: 2 } as never,
      }),
    );
    const outOfOrder = tracker.observe(
      packet("iracing", {
        TimestampMS: 22,
        iracing: { sessionTick: 1 } as never,
      }),
    );

    expect(duplicate.boundaries[0]).toMatchObject({
      kind: "duplicate",
      sourceSequenceFamily: "iracing-session-tick",
      previousSequence: 2,
      currentSequence: 2,
    });
    expect(outOfOrder.boundaries[0]).toMatchObject({
      kind: "out-of-order",
      previousSequence: 2,
      currentSequence: 1,
    });
  });

  test("finalizes exact native gap boundaries with the weighted-median step", () => {
    const tracker = new SourceSequenceTracker();
    for (const [sessionTick, TimestampMS] of [
      [1, 0],
      [2, 10],
      [3, 20],
      [6, 50],
    ] as const) {
      tracker.observe(
        packet("iracing", {
          TimestampMS,
          iracing: { sessionTick } as never,
        }),
      );
    }

    const result = tracker.finalize();
    expect(result.summary).toMatchObject({
      expectedCount: 6,
      observedCount: 4,
      totalMissingCount: 2,
      countMethod: "native-sequence",
    });
    expect(result.gaps).toEqual([
      expect.objectContaining({
        sourceSequenceFamily: "iracing-session-tick",
        previousSequence: 3,
        currentSequence: 6,
        durationMs: 30,
        missingCount: 2,
      }),
    ]);
  });

  test("uses timestamp cadence only when no native family exists", () => {
    const tracker = new SourceSequenceTracker();
    for (const TimestampMS of [0, 10, 20, 50]) {
      tracker.observe(packet("fm-2023", { TimestampMS }));
    }
    const result = tracker.finalize();
    expect(result.summary).toMatchObject({
      totalMissingCount: 2,
      countMethod: "timestamp-estimate",
    });
    expect(result.gaps[0]).toMatchObject({
      sourceSequenceFamily: null,
      previousSourceTimeMs: 20,
      currentSourceTimeMs: 50,
      missingCount: 2,
    });
  });

  test("seeds the next coordinate after a discontinuity", () => {
    const tracker = new SourceSequenceTracker();
    tracker.observe(
      packet("iracing", { iracing: { sessionTick: 50 } as never }),
    );
    tracker.markDiscontinuity();
    const reset = tracker.observe(
      packet("iracing", {
        TimestampMS: 2_000,
        iracing: { sessionTick: 1 } as never,
      }),
    );
    expect(reset.boundaries).toEqual([]);
  });

  test("is the recording quality accumulator's source of gap counts", () => {
    const packets = [1, 2, 5].map((sessionTick, index) =>
      packet("iracing", {
        TimestampMS: index * 10,
        iracing: { sessionTick } as never,
      }),
    );
    const tracker = new SourceSequenceTracker();
    const quality = new RecordingQualityAccumulator(
      "native-live",
      {
        kind: "player",
        sourceId: null,
        stableId: "local-player",
        identityState: "stable",
      },
      {
        catalogVersion: "test",
        catalogHash: "test",
        catalogSchemaVersion: "test",
        parserVersion: "test",
        resolverVersion: "test",
        derivationVersion: "test",
      },
    );
    for (const value of packets) {
      tracker.observe(value);
      quality.observe(value);
    }

    const finalized = quality.finalize("test", {
      state: "verified",
      sourceGeneration: "test",
    });
    expect(finalized.gapSummary).toEqual(tracker.finalize().summary);
  });

  test("keeps timestamp high-water after late timestamp-only packets", () => {
    const tracker = new SourceSequenceTracker();
    for (const TimestampMS of [0, 10, 5, 6, 7]) {
      tracker.observe(packet("fm-2023", { TimestampMS }));
    }
    expect(tracker.finalize().outOfOrder).toEqual([
      expect.objectContaining({ previousSourceTimeMs: 10, currentSourceTimeMs: 5 }),
      expect.objectContaining({ previousSourceTimeMs: 10, currentSourceTimeMs: 6 }),
      expect.objectContaining({ previousSourceTimeMs: 10, currentSourceTimeMs: 7 }),
    ]);
  });

  test("bounds normal native stream state", () => {
    const tracker = new SourceSequenceTracker();
    for (let sessionTick = 0; sessionTick < 10_000; sessionTick += 1) {
      tracker.observe(packet("iracing", {
        TimestampMS: sessionTick * 10,
        iracing: { sessionTick } as never,
      }));
    }
    const state = (tracker as unknown as {
      nativeStates: Map<string, { gapCandidates: unknown[] }>;
      timestampGapCandidates: unknown[];
    });
    expect(state.nativeStates.get("iracing-session-tick")?.gapCandidates).toHaveLength(0);
    expect(state.timestampGapCandidates).toHaveLength(0);
  });
  test("bounds cadence jitter after warmup", () => {
    const tracker = new SourceSequenceTracker();
    let timestamp = 0;
    for (let index = 0; index < 10_000; index += 1) {
      timestamp += index % 2 === 0 ? 16 : 17;
      tracker.observe(packet("fm-2023", { TimestampMS: timestamp }));
    }
    const state = tracker as unknown as { timestampGapCandidates: unknown[] };
    expect(state.timestampGapCandidates.length).toBeLessThanOrEqual(1);
  });

});
