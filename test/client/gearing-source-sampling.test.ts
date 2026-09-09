import { describe, expect, it } from "bun:test";
import {
  SOURCE_SAMPLE_INTERVAL_MS,
  sourceSampleAccept,
  sourceSampleDue,
  type SourceSampleClock,
} from "../../client/src/hooks/useGearingIngest";

const newClock = (): SourceSampleClock => ({ streamId: null, lastSequence: -1, lastObservedAtMs: 0 });
const frame = (sequence: number, observedAtMs: number, streamId = "s") => ({ streamId, sequence, observedAtMs });

describe("source-clock sampling", () => {
  it("accepts the first frame of a stream", () => {
    expect(sourceSampleDue(newClock(), frame(0, 0))).toBe(true);
  });

  it("rejects frames inside the source-time interval", () => {
    const clock = newClock();
    sourceSampleDue(clock, frame(0, 0));
    sourceSampleAccept(clock, frame(0, 0));
    expect(sourceSampleDue(clock, frame(1, 50))).toBe(false);
    expect(sourceSampleDue(clock, frame(2, SOURCE_SAMPLE_INTERVAL_MS - 1))).toBe(false);
  });

  it("accepts the first frame at or beyond the interval", () => {
    const clock = newClock();
    sourceSampleDue(clock, frame(0, 0));
    sourceSampleAccept(clock, frame(0, 0));
    expect(sourceSampleDue(clock, frame(1, SOURCE_SAMPLE_INTERVAL_MS))).toBe(true);
  });

  it("rejects out-of-order and duplicate frames", () => {
    const clock = newClock();
    sourceSampleDue(clock, frame(0, 0));
    sourceSampleAccept(clock, frame(0, 0));
    sourceSampleDue(clock, frame(1, SOURCE_SAMPLE_INTERVAL_MS));
    sourceSampleAccept(clock, frame(1, SOURCE_SAMPLE_INTERVAL_MS));
    expect(sourceSampleDue(clock, frame(0, 500))).toBe(false); // stale sequence
    expect(sourceSampleDue(clock, frame(1, 500))).toBe(false); // duplicate sequence
  });

  it("resets the baseline on stream change", () => {
    const clock = newClock();
    sourceSampleDue(clock, frame(10, 5000));
    sourceSampleAccept(clock, frame(10, 5000));
    // A new stream restarts sequence + observed timestamps on the server.
    expect(sourceSampleDue(clock, frame(0, 0, "s2"))).toBe(true);
  });

  it("does not advance the window until a frame is accepted", () => {
    const clock = newClock();
    sourceSampleDue(clock, frame(0, 0));
    sourceSampleAccept(clock, frame(0, 0));
    // Frame 1 is due but rejected downstream (missing semantics) — not accepted.
    expect(sourceSampleDue(clock, frame(1, 200))).toBe(true);
    // Frame 2 stays relative to frame 0's timestamp, not frame 1's.
    expect(sourceSampleDue(clock, frame(2, 250))).toBe(true);
  });

  it("samples by source time, so a burst delivered together still yields ~10 Hz", () => {
    const clock = newClock();
    const accepted: number[] = [];
    // 15 frames at 16 ms source spacing processed in one synchronous burst —
    // wall-clock arrival time is irrelevant to which frames get ingested.
    for (let sequence = 0; sequence < 15; sequence++) {
      const f = frame(sequence, sequence * 16);
      if (sourceSampleDue(clock, f)) {
        sourceSampleAccept(clock, f);
        accepted.push(sequence);
      }
    }
    expect(accepted).toEqual([0, 7, 14]);
  });
});
