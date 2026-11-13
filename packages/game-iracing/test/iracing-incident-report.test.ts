import { describe, expect, test } from "bun:test";
import { reduceIRacingIncidents, type IRacingIncidentInput, type IRacingIncidentLapInput, type IRacingIncidentSample } from "../src/incident-report";
import type { IRacingIncidentCoverageReason } from "@raceiq/shared/racing/sessions/iracing-incidents";

const laps: IRacingIncidentLapInput[] = [
  { lapId: 1, lapNumber: 1, eligibleForCleanStreak: true },
  { lapId: 2, lapNumber: 2, eligibleForCleanStreak: true },
  { lapId: 3, lapNumber: 3, eligibleForCleanStreak: false },
];
function sample(lapId: number, rawOffset: number, time: number | null, count: number | null, surface: number | null, extra: Partial<IRacingIncidentSample> = {}): IRacingIncidentSample {
  return { kind: "sample", lapId, rawOffset, nativeSessionUid: "sub:session:1", driverCarIdx: 4, sessionTick: rawOffset, sessionTimeSec: time, incidentPoints: count, surface, ...extra };
}
const reduce = (items: IRacingIncidentInput[], selected = laps) => reduceIRacingIncidents(selected, items);

 describe("reduceIRacingIncidents", () => {
  test("uses first valid count as baseline and emits later positive differences in capture order", async () => {
    const result = await reduce([
      sample(1, 10, 1, 2, 3), sample(1, 11, 1.05, 2, 3), sample(1, 12, 1.1, 3, 3),
      sample(2, 20, 1.15, 3, 3), sample(2, 21, 1.2, 5, 3),
    ]);
    expect(result.events.filter(e => e.kind === "incident-points").map(e => [e.id, e.points, e.previousSessionTimeSec, e.lapId])).toEqual([
      ["incident-points:1:12", 1, 1.05, 1], ["incident-points:2:21", 2, 1.15, 2],
    ]);
    expect(result.observedIncidentPoints).toBe(3);
    expect(result.events.every(e => e.replay === null)).toBe(true);
    expect(result.events.map(e => e.seekReference.sessionTimeSec)).toEqual([1.1, 1.2]);
  });

  test("does not substitute flags/team-like data; invalid counts interrupt comparability and surfaces remain independent", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, null, 0), sample(1, 3, .1, 2, 0), sample(1, 4, .15, 3, 0),
    ]);
    expect(result.observedIncidentPoints).toBe(1);
    expect(result.events.filter(e => e.kind === "incident-points").map(e => e.points)).toEqual([1]);
    expect(result.laps[0]).toMatchObject({ incidentStatus: "partial", surfaceStatus: "available" });
    expect(result.laps[0].observedOffTrackSeconds).toBeCloseTo(.1);
    for (const invalid of [-1, 1.5, NaN, Infinity, -Infinity]) {
      const isolated = await reduce([sample(1, 1, 0, invalid, 3), sample(1, 2, .05, 4, 3)]);
      expect(isolated.observedIncidentPoints).toBeNull();
    }
  });

  test("counter decrease rebaselines without negative events and preserves later comparable increases", async () => {
    const result = await reduce([sample(1, 1, 0, 4, 3), sample(1, 2, .05, 2, 3), sample(1, 3, .1, 3, 3)]);
    expect(result.reasons).toContain("counter-reset");
    expect(result.events.filter(e => e.kind === "incident-points").map(e => [e.points, e.id])).toEqual([[1, "incident-points:1:3"]]);
    expect(result.observedIncidentPoints).toBe(1);
    expect(result.laps[0].incidentStatus).toBe("partial");
  });

  test("creates lap-clipped sampled spans with known boundary flags and zero duration at equal time", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 0), sample(1, 3, .1, 0, 0), sample(1, 4, .1, 0, 3),
      sample(2, 5, .15, 0, 0), sample(2, 6, .2, 0, 3), sample(3, 7, .25, 0, 0),
    ]);
    const spans = result.events.filter(e => e.kind === "off-track");
    expect(spans.map(e => e.kind === "off-track" ? [e.id, e.lapId, e.observedSeconds, e.startObserved, e.endObserved] : [])).toEqual([
      ["off-track:1:2", 1, .05, true, true], ["off-track:2:5", 2, 0, false, true], ["off-track:3:7", 3, 0, false, false],
    ]);
    expect(result.offTrackSpans).toBe(3);
    expect(result.observedOffTrackSeconds).toBeCloseTo(.05);
  });

  test("treats pits as known non-off-track, unknown and not-in-world as continuity breaks", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 1), sample(1, 2, .05, 0, 0), sample(1, 3, .1, 0, 2),
      sample(1, 4, .15, 0, 0), sample(1, 5, .2, 0, -1), sample(1, 6, .25, 0, 0), sample(1, 7, .3, 0, null),
    ]);
    const spans = result.events.filter(e => e.kind === "off-track");
    expect(spans).toHaveLength(3);
    expect(spans.map(e => e.kind === "off-track" ? [e.startObserved, e.endObserved] : [])).toEqual([[true, true], [true, false], [false, false]]);
    expect(result.laps[0].surfaceStatus).toBe("partial");
  });

  test("breaks both channels on time reset, identity change, excessive gap, explicit break, and missing time", async () => {
    const cases: Array<{ items: IRacingIncidentInput[]; reason: IRacingIncidentCoverageReason }> = [
      { items: [sample(1, 1, .1, 0, 3), sample(1, 2, .05, 1, 3)], reason: "time-reset" },
      { items: [sample(1, 1, 0, 0, 3), sample(1, 2, .05, 1, 3, { nativeSessionUid: "other" })], reason: "segment-boundary" },
      { items: [sample(1, 1, 0, 0, 3), sample(1, 2, .10101, 1, 3)], reason: "capture-gap" },
      { items: [sample(1, 1, 0, 0, 3), { kind: "break", reason: "decode-failure" }, sample(1, 2, .05, 1, 3)], reason: "decode-failure" },
      { items: [sample(1, 1, 0, 0, 3), sample(1, 2, null, 1, 3)], reason: "missing-evidence" },
    ];
    for (const { items, reason } of cases) {
      const result = await reduce(items);
      expect(result.reasons).toContain(reason);
      expect(result.events.filter(e => e.kind === "incident-points")).toHaveLength(0);
      expect(result.laps[0].incidentStatus).toBe("partial");
      expect(result.laps[0].surfaceStatus).toBe("partial");
    }
    const allowed = await reduce([sample(1, 1, 0, 0, 3), sample(1, 2, .101, 1, 3)]);
    expect(allowed.events.filter(e => e.kind === "incident-points")).toHaveLength(1);
  });

  test("driver identity and unowned records interrupt comparisons; unowned interval cannot earn point attribution", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 1, 3, { driverCarIdx: 5 }),
      sample(99, 3, .1, 1, 3), sample(1, 4, .15, 2, 3),
    ]);
    expect(result.reasons).toContain("segment-boundary");
    expect(result.events.filter(e => e.kind === "incident-points")).toHaveLength(0);
    expect(result.observedIncidentPoints).toBeNull();
  });

  test("lap breaks invalidate named lap, unnamed breaks separate continuity, and async input is accepted", async () => {
    async function* items() {
      yield sample(1, 1, 0, 0, 3);
      yield sample(1, 2, .05, 0, 3);
      yield { kind: "break", reason: "capture-gap" } as const;
      yield sample(2, 3, .1, 0, 3);
      yield sample(2, 4, .15, 0, 3);
      yield { kind: "break", reason: "decode-failure", lapId: 2 } as const;
    }
    const result = await reduceIRacingIncidents(laps, items());
    expect(result.laps[0].incidentStatus).toBe("available");
    expect(result.laps[1].incidentStatus).toBe("partial");
    expect(result.laps[1].surfaceStatus).toBe("partial");
    expect(result.reasons).toEqual(expect.arrayContaining(["capture-gap", "decode-failure"]));
  });

  test("summarizes null versus observed-zero metrics and evidence availability independently", async () => {
    const noEvidence = await reduce([], laps);
    expect(noEvidence).toMatchObject({ incidentStatus: "unavailable", surfaceStatus: "unavailable", observedIncidentPoints: null, offTrackSpans: null, observedOffTrackSeconds: null, longestCleanLapStreak: null });
    const single = await reduce([sample(1, 1, 0, 0, 3)], laps.slice(0, 1));
    expect(single).toMatchObject({ observedIncidentPoints: null, offTrackSpans: 0, observedOffTrackSeconds: null, longestCleanLapStreak: null });
    const zero = await reduce([sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3)], laps.slice(0, 1));
    expect(zero).toMatchObject({ incidentStatus: "available", surfaceStatus: "available", observedIncidentPoints: 0, offTrackSpans: 0, observedOffTrackSeconds: 0, longestCleanLapStreak: 1 });
  });

  test("clean streak respects eligibility, lap-number continuity, point increases, and absent eligible evidence", async () => {
    const cleanPair = await reduce([sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3), sample(2, 3, .1, 0, 3), sample(2, 4, .15, 0, 3)], laps.slice(0, 2));
    expect(cleanPair.longestCleanLapStreak).toBe(2);
    const ineligible = await reduce([sample(3, 1, 0, 0, 3), sample(3, 2, .05, 0, 3)], [laps[2]]);
    expect(ineligible.longestCleanLapStreak).toBeNull();
    const consecutiveRule = await reduce([sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3), sample(2, 3, .1, 0, 3), sample(2, 4, .15, 0, 3)], [laps[0], { ...laps[1], lapNumber: 4 }]);
    expect(consecutiveRule.longestCleanLapStreak).toBe(1);
    const point = await reduce([sample(1, 1, 0, 0, 3), sample(1, 2, .05, 1, 3), sample(2, 3, .1, 1, 3), sample(2, 4, .15, 1, 3)], laps.slice(0, 2));
    expect(point.longestCleanLapStreak).toBe(1);
  });
  test("keeps equal-time changed counts but adds no elapsed surface duration", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 0), sample(1, 2, 0, 1, 3),
      sample(1, 3, .05, 1, 3),
    ], laps.slice(0, 1));
    expect(result.events.filter(event => event.kind === "incident-points").map(event => event.points)).toEqual([1]);
    expect(result.events.find(event => event.kind === "off-track")).toMatchObject({ observedSeconds: 0, startObserved: false, endObserved: true });
  });

  test("does not bridge clean streak across an unnamed continuity break", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      { kind: "break", reason: "segment-boundary" },
      sample(2, 3, .1, 0, 3), sample(2, 4, .15, 0, 3),
    ], laps.slice(0, 2));
    expect(result.longestCleanLapStreak).toBe(1);
    expect(result.reasons).toContain("segment-boundary");
  });

  test("captures isolated off-track sample at lap edge as zero-duration clipped span", async () => {
    const result = await reduce([sample(1, 1, 0, 0, 0)], laps.slice(0, 1));
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: "off-track", id: "off-track:1:1", observedSeconds: 0, startObserved: false, endObserved: false,
    }));
    expect(result.laps[0]).toMatchObject({ surfaceStatus: "partial", offTrackSpans: 1, observedOffTrackSeconds: null });
  });

  test("does not infer off-track duration across unknown surface observations", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 0), sample(1, 3, .1, 0, null),
      sample(1, 4, .15, 0, 0), sample(1, 5, .2, 0, 3),
    ], laps.slice(0, 1));
    const spans = result.events.filter(event => event.kind === "off-track");
    expect(spans.map(event => event.kind === "off-track" ? [event.observedSeconds, event.startObserved, event.endObserved] : [])).toEqual([[0, true, false], [0, false, true]]);
  });

  test("does not count missing or invalid separated observations as comparable pairs", async () => {
    for (const missing of [null, -1, 2.5, NaN, Infinity]) {
      const result = await reduce([
        sample(1, 1, 0, 0, 3),
        sample(1, 2, .05, missing, 3),
        sample(1, 3, .1, 1, 3),
      ], laps.slice(0, 1));
      expect(result.observedIncidentPoints).toBeNull();
      expect(result.laps[0].incidentStatus).toBe("partial");
      expect(result.events.filter(event => event.kind === "incident-points")).toHaveLength(0);
    }
  });

  test("named breaks mark a noncurrent lap partial and unnamed breaks partially cover aggregates", async () => {
    const named = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      sample(2, 3, .1, 0, 3),
      { kind: "break", reason: "decode-failure", lapId: 1 },
      sample(2, 4, .15, 0, 3),
    ], laps.slice(0, 2));
    expect(named.laps[0].incidentStatus).toBe("partial");
    expect(named.laps[1].incidentStatus).toBe("available");

    const separated = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      { kind: "break", reason: "segment-boundary" },
      sample(2, 3, .1, 0, 3), sample(2, 4, .15, 0, 3),
    ], laps.slice(0, 2));
    expect(separated.incidentStatus).toBe("partial");
    expect(separated.surfaceStatus).toBe("partial");
  });

  test("ignores identical equal-time duplicates and keeps surface evidence independent of counter reset", async () => {
    const first = sample(1, 1, 0, 4, 3);
    const result = await reduce([
      first, { ...first, rawOffset: 2 }, sample(1, 3, .05, 2, 0),
      sample(1, 4, .1, 3, 3),
    ], laps.slice(0, 1));
    expect(result.reasons).toContain("counter-reset");
    expect(result.events.filter(event => event.kind === "incident-points").map(event => event.points)).toEqual([1]);
    expect(result.laps[0]).toMatchObject({ incidentStatus: "partial", surfaceStatus: "available" });
    expect(result.events.filter(event => event.kind === "off-track")).toHaveLength(1);
  });

  test("missing surface preserves comparable count changes", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 1, null), sample(1, 3, .1, 2, 3),
    ], laps.slice(0, 1));
    expect(result.observedIncidentPoints).toBe(2);
    expect(result.events.filter(event => event.kind === "incident-points").map(event => event.points)).toEqual([1, 1]);
    expect(result.laps[0].incidentStatus).toBe("available");
    expect(result.laps[0].surfaceStatus).toBe("partial");
  });

  test("clips continuing off-track state at lap boundary without bridging duration", async () => {
    const result = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 0),
      sample(2, 3, .1, 0, 0), sample(2, 4, .15, 0, 3),
    ], laps.slice(0, 2));
    expect(result.events.filter(event => event.kind === "off-track").map(event => event.kind === "off-track"
      ? [event.lapId, event.observedSeconds, event.startObserved, event.endObserved]
      : [])).toEqual([[1, 0, true, false], [2, 0, false, true]]);
    expect(result.observedOffTrackSeconds).toBe(0);
  });

  test("retains capture event order when counter events follow clock reset", async () => {
    const result = await reduce([
      sample(1, 1, 10, 0, 3), sample(1, 2, 10.05, 1, 3),
      sample(1, 3, 1, 0, 3), sample(1, 4, 1.05, 2, 3),
    ], laps.slice(0, 1));
    expect(result.events.filter(event => event.kind === "incident-points").map(event => event.id)).toEqual([
      "incident-points:1:2", "incident-points:1:4",
    ]);
    expect(result.observedIncidentPoints).toBe(3);
    expect(result.reasons).toContain("time-reset");
  });

  test("clean streak breaks on reset, gap, missing evidence, ineligible and number discontinuity", async () => {
    const two = laps.slice(0, 2);
    const pairs = [
      [sample(1, 1, 0, 0, 3), sample(1, 2, .05, 1, 3), sample(2, 3, .1, 1, 3), sample(2, 4, .15, 1, 3)],
      [sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3), sample(2, 3, .2, 0, 3), sample(2, 4, .25, 0, 3)],
      [sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3), sample(2, 3, .1, null, 3), sample(2, 4, .15, 0, 3)],
    ];
    for (const items of pairs) {
      const result = await reduce(items, two);
      expect(result.longestCleanLapStreak).toBe(1);
    }
    const ineligible = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      sample(2, 3, .1, 0, 3), sample(2, 4, .15, 0, 3),
    ], [two[0], { ...two[1], eligibleForCleanStreak: false }]);
    expect(ineligible.longestCleanLapStreak).toBe(1);
    const discontinuous = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      sample(2, 3, .1, 0, 3), sample(2, 4, .15, 0, 3),
    ], [two[0], { ...two[1], lapNumber: 4 }]);
    expect(discontinuous.longestCleanLapStreak).toBe(1);
  });

  test("outside-window breaks do not invalidate full coverage, but resumed same-lap breaks do", async () => {
    const selected = laps.slice(0, 1);
    const outside = await reduce([
      { kind: "break", reason: "segment-boundary" },
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      { kind: "break", reason: "capture-gap" },
    ], selected);
    expect(outside.incidentStatus).toBe("available");
    expect(outside.surfaceStatus).toBe("available");
    const inside = await reduce([
      sample(1, 1, 0, 0, 3), sample(1, 2, .05, 0, 3),
      { kind: "break", reason: "capture-gap" },
      sample(1, 3, .1, 0, 3), sample(1, 4, .15, 0, 3),
    ], selected);
    expect(inside.laps[0].incidentStatus).toBe("partial");
    expect(inside.laps[0].surfaceStatus).toBe("partial");
    expect(inside.longestCleanLapStreak).toBeNull();
  });

});
