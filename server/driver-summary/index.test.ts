import assert from "node:assert/strict";
import test from "node:test";
import { reduceDriverSummaryFacts, type DriverSummaryLapFact } from "./index";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";

function stint(attribution: "Self" | "Other" | "Unknown", startMs = 0, endMs: number | null = 100): DriverAttributionStint {
  const actor = attribution === "Unknown" ? null : {
    gameId: "acc" as const, source: "native", actorId: attribution === "Self" ? "driver-self" : "driver-other",
    bindingScope: "installation" as const, sessionId: "native-session", clockDomain: "clock", observedAtMs: 1,
  };
  return { gameId: "acc", source: "native", sessionId: "native-session", startMs, endMs, evidenceValidUntilMs: 100,
    clockDomain: "clock", actor, attribution, bindingRevision: actor ? 1 : null };
}

function lap(overrides: Partial<DriverSummaryLapFact> = {}): DriverSummaryLapFact {
  return {
    sessionId: 1, gameId: "acc", carId: "car-a", trackId: "track-a", sessionType: "race",
    createdAtMs: 1_000, originalActivityId: "original-a", ownerUserId: null, ownership: "mine",
    sessionAttribution: "Self", sessionStints: [], elapsedSeconds: null, durationStatus: "unavailable",
    trackLengthMeters: 1_000, lapId: 1, lapGuid: "guid-1", lapTime: 60, valid: true, invalidReason: null,
    lapAttribution: "Self", lapStints: [stint("Self")], clockDomain: "clock", lapStartMs: 10, lapEndMs: 90, stampMs: 1_000,
    ...overrides,
  };
}

test("personal summary reuses positive-time eligibility and keeps non-personal context separate", () => {
  const mixedStints = [stint("Self", 0, 50), stint("Other", 50, 100)];
  const result = reduceDriverSummaryFacts([
    lap(),
    lap({ lapId: 2, lapGuid: "guid-2", carId: "car-b", trackId: "track-b", lapTime: 30 }),
    lap({ lapId: 3, lapGuid: "guid-3", carId: "car-b", trackId: "track-b", lapTime: 30 }),
    lap({ lapId: 4, lapGuid: "guid-4", carId: "car-a", lapTime: 40, valid: false, invalidReason: "incomplete" }),
    lap({ lapId: 5, lapGuid: "guid-5", lapTime: 45, lapAttribution: "Other", lapStints: [stint("Other")] }),
    lap({ lapId: 6, lapGuid: "guid-6", lapTime: 55, lapAttribution: "Mixed", lapStints: mixedStints }),
    lap({ lapId: 7, lapGuid: "guid-7", lapTime: 65, lapAttribution: "Self", lapStints: [stint("Unknown")] }),
  ]);

  assert.deepEqual(result.summary.metrics, {
    laps: 4, positiveLaps: 4, validLaps: 3, drivenSeconds: 160, validSeconds: 120, distanceMeters: 3_000,
    sessionTypeSeconds: { practice: 0, qualifying: 0, race: 0, unknown: 0 }, sessionsWithDuration: 0, sessionsWithoutDuration: 1,
  });
  assert.equal(result.summary.games[0]?.favoriteCar?.nativeId, "car-b");
  assert.deepEqual(result.summary.games[0]?.favoriteCar && {
    seconds: result.summary.games[0].favoriteCar.seconds, laps: result.summary.games[0].favoriteCar.laps,
  }, { seconds: 60, laps: 2 });
  assert.deepEqual(result.context, {
    basis: "positive_lap_time", other: { laps: 1, seconds: 45 }, mixed: { laps: 1, seconds: 55 }, unknown: { laps: 1, seconds: 65 },
  });
  assert.equal(result.coverage.driverAttribution, "partial");
  assert.equal(result.coverage.sessionDuration, "unavailable");
});
test("historical source Self remains personal after unrelated current-session binding changes", () => {
  const result = reduceDriverSummaryFacts([
    lap(),
    lap({ sessionId: 2, lapId: 2, lapGuid: "guid-2", originalActivityId: "original-b",
      lapStints: [{ ...stint("Self"), bindingRevision: 8, sessionId: "later-native-session",
        actor: { ...stint("Self").actor!, sessionId: "later-native-session" } }] }),
  ]);
  assert.equal(result.summary.metrics.laps, 2);
  assert.equal(result.summary.metrics.drivenSeconds, 120);
  assert.deepEqual(result.context.unknown, { laps: 0, seconds: 0 });
  assert.equal(result.coverage.driverAttribution, "complete");
});

test("measured Self duration survives an empty-lap session without manufacturing headline time", () => {
  const result = reduceDriverSummaryFacts([lap({
    lapId: null, lapGuid: null, lapTime: 0, lapStints: [], clockDomain: null, lapStartMs: null, lapEndMs: null,
    sessionType: "unknown-native-category",
    durationAttribution: { selfSeconds: 12, otherSeconds: 7, unknownSeconds: 0, selfObserved: true, coverage: "complete" },
  })]);
  assert.deepEqual(result.summary.metrics, {
    laps: 0, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, validSeconds: 0, distanceMeters: null,
    sessionTypeSeconds: { practice: 0, qualifying: 0, race: 0, unknown: 12 }, sessionsWithDuration: 1, sessionsWithoutDuration: 0,
  });
  assert.equal(result.coverage.sessionDuration, "complete");
  assert.equal(result.coverage.identity, "complete");
  assert.equal(result.summary.games[0]?.favoriteCar, null);
  assert.deepEqual(result.context.unknown, { laps: 0, seconds: 0 });
});

test("duration partial gaps remain partial and unavailable empty sums differ from measured zero", () => {
  const measuredZero = lap({ durationAttribution: {
    selfSeconds: 0, otherSeconds: 0, unknownSeconds: 0, selfObserved: true, coverage: "complete",
  } });
  const partial = lap({ sessionId: 2, durationAttribution: {
    selfSeconds: 8, otherSeconds: 4, unknownSeconds: 3, selfObserved: true, coverage: "partial",
  } });
  const result = reduceDriverSummaryFacts([measuredZero, partial, lap({ sessionId: 3 })]);
  assert.deepEqual(result.summary.metrics.sessionTypeSeconds, { practice: 0, qualifying: 0, race: 8, unknown: 0 });
  assert.equal(result.summary.metrics.sessionsWithDuration, 2);
  assert.equal(result.summary.metrics.sessionsWithoutDuration, 1);
  assert.equal(result.coverage.sessionDuration, "partial");
  const zero = reduceDriverSummaryFacts([measuredZero]);
  assert.equal(zero.coverage.sessionDuration, "complete");
  assert.equal(zero.summary.metrics.sessionsWithDuration, 1);
  const unavailable = reduceDriverSummaryFacts([lap()]);
  assert.equal(unavailable.coverage.sessionDuration, "unavailable");
  assert.equal(unavailable.summary.metrics.sessionsWithDuration, 0);
});

test("lap and duration period membership remain independent half-open cohorts", () => {
  const duration = { selfSeconds: 20, otherSeconds: 0, unknownSeconds: 0, selfObserved: true, coverage: "complete" as const };
  const result = reduceDriverSummaryFacts([
    lap({ sessionInPeriod: true, lapInPeriod: false, durationAttribution: duration }),
    lap({ sessionId: 2, sessionInPeriod: false, lapInPeriod: true, durationAttribution: duration }),
  ]);
  assert.equal(result.summary.metrics.laps, 1);
  assert.equal(result.summary.metrics.drivenSeconds, 60);
  assert.equal(result.summary.metrics.sessionTypeSeconds.race, 20);
  assert.equal(result.summary.metrics.sessionsWithDuration, 1);
});

test("borrowed input cannot become personal through Self stints or measured duration", () => {
  const result = reduceDriverSummaryFacts([lap({ ownership: "others", durationAttribution: {
    selfSeconds: 100, otherSeconds: 0, unknownSeconds: 0, selfObserved: true, coverage: "complete",
  } })]);
  assert.equal(result.summary.metrics.laps, 0);
  assert.equal(result.summary.metrics.drivenSeconds, 0);
  assert.equal(result.summary.metrics.sessionsWithDuration, 0);
  assert.equal(result.summary.metrics.sessionTypeSeconds.race, 0);
  assert.deepEqual(result.summary.games, []);
});

test("an incomplete positive lap contributes headline time but not favourite or distance observations", () => {
  const result = reduceDriverSummaryFacts([lap({ valid: false, invalidReason: "incomplete" })]);
  assert.equal(result.summary.metrics.drivenSeconds, 60);
  assert.equal(result.summary.games[0]?.favoriteCar, null);
  assert.equal(result.summary.metrics.distanceMeters, null);
  assert.equal(result.coverage.distance, "unavailable");
});
