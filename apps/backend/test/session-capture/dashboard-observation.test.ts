import assert from "node:assert/strict";
import { beforeEach, test } from "bun:test";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { DashboardCaptureObservation } from "@raceiq/backend-core/session-capture/dashboard-observation";
import { NativeAttributionTracker, getNativeSourceClock, nativeDriverBindings, encodeNativeDriverBinding } from "@raceiq/backend-core/lap-detection/native-attribution";
import { lmuDriverAttributionCapability } from "@raceiq/game-lmu-metadata/driver-attribution";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";

beforeEach(() => {
  initGameAdapters();
  initServerGameAdapters();
});

function stint(attribution: "Self" | "Other", startMs = 0, endMs = 100): DriverAttributionStint {
  return { gameId: "f1-2025", source: "native", sessionId: "source-session", clockDomain: "sdk-clock",
    startMs, endMs, evidenceValidUntilMs: endMs, attribution, bindingRevision: 1,
    actor: { gameId: "f1-2025", source: "native", actorId: attribution, bindingScope: "installation",
      sessionId: "source-session", clockDomain: "sdk-clock", observedAtMs: startMs } };
}
const packet = { gameId: "f1-2025", CurrentRaceTime: 500, TimestampMS: 0 } as TelemetryPacket;
function source(sourceTimeMs: number, stints: readonly DriverAttributionStint[] = [stint("Self")]) {
  return { sessionId: "source-session", clockDomain: "sdk-clock", sourceTimeMs, stints };
}

function lmuPacket(elapsedTime: number): TelemetryPacket {
  const available = Number.isFinite(elapsedTime) && elapsedTime >= 0;
  const sessionId = JSON.stringify([1202, 9, 10, "ferrari_499p_2023", "lemans_2023/lemanswec", 42]);
  return { gameId: "lmu", IsRaceOn: 1, TimestampMS: 0, CurrentRaceTime: available ? elapsedTime : 0, sessionUID: sessionId,
    lmu: { elapsedTime: available ? elapsedTime : null },
    driverActor: available ? { gameId: "lmu", source: lmuDriverAttributionCapability.source, actorId: "lmu-control:0",
      bindingScope: "installation", sessionId, clockDomain: `lmu-session:${sessionId}`, observedAtMs: elapsedTime * 1000 } : null,
  } as TelemetryPacket;
}

test("paired observations measure wrapper-clock Self seconds without equating SDK clocks", () => {
  const observer = new DashboardCaptureObservation("f1-2025", null);
  observer.observe(packet, undefined, 1_000, source(10));
  observer.observe(packet, undefined, 5_000, source(20));
  assert.deepEqual(observer.toFacts().duration, { status: "available", elapsedSeconds: 4,
    attribution: { selfSeconds: 4, otherSeconds: 0, unknownSeconds: 0, selfObserved: true, coverage: "complete" } });
});

test("observed driver boundary separates Self and Other without personal whole-mixed time", () => {
  const observer = new DashboardCaptureObservation("f1-2025", null);
  const stints = [stint("Self", 0, 20), stint("Other", 20, 40)];
  observer.observe(packet, undefined, 1_000, source(10, stints));
  observer.observe(packet, undefined, 4_000, source(20, stints));
  observer.observe(packet, undefined, 5_000, source(30, stints));
  assert.deepEqual(observer.toFacts().duration.attribution,
    { selfSeconds: 3, otherSeconds: 1, unknownSeconds: 0, selfObserved: true, coverage: "complete" });
  const unsampledSwap = new DashboardCaptureObservation("f1-2025", null);
  unsampledSwap.observe(packet, undefined, 1_000, source(10, stints));
  unsampledSwap.observe(packet, undefined, 5_000, source(30, stints));
  assert.deepEqual(unsampledSwap.toFacts().duration.attribution,
    { selfSeconds: 0, otherSeconds: 0, unknownSeconds: 4, selfObserved: false, coverage: "unavailable" });
});

test("missing source observations preserve measured Self sums with partial coverage", () => {
  const observer = new DashboardCaptureObservation("f1-2025", null);
  observer.observe(packet, undefined, 1_000, source(10));
  observer.observe(packet, undefined, 4_000, source(20));
  observer.observe(packet, undefined, 6_000);
  observer.observe(packet, undefined, 7_000, source(40));
  observer.observe(packet, undefined, 9_000, source(50));
  assert.deepEqual(observer.toFacts().duration.attribution,
    { selfSeconds: 5, otherSeconds: 0, unknownSeconds: 3, selfObserved: true, coverage: "partial" });
});

test("source-session changes and clock rollback cannot bridge measured intervals", () => {
  const observer = new DashboardCaptureObservation("f1-2025", null);
  observer.observe(packet, undefined, 1_000, source(10));
  observer.observe(packet, undefined, 2_000, source(20));
  observer.observe(packet, undefined, 3_000, { ...source(30), sessionId: "different-source" });
  observer.observe(packet, undefined, 2_500, source(40));
  assert.deepEqual(observer.toFacts().duration.attribution,
    { selfSeconds: 1, otherSeconds: 0, unknownSeconds: 1, selfObserved: true, coverage: "partial" });
});

test("measured zero remains distinguishable from unavailable empty sum", () => {
  const observer = new DashboardCaptureObservation("f1-2025", null);
  observer.observe(packet, undefined, 1_000, source(10));
  observer.observe(packet, undefined, 1_000, source(20));
  assert.deepEqual(observer.toFacts().duration.attribution,
    { selfSeconds: 0, otherSeconds: 0, unknownSeconds: 0, selfObserved: true, coverage: "complete" });
  const unproven = new DashboardCaptureObservation("f1-2025", null);
  unproven.observe(packet, undefined, 1_000);
  unproven.observe(packet, undefined, 2_000);
  assert.deepEqual(unproven.toFacts().duration.attribution,
    { selfSeconds: 0, otherSeconds: 0, unknownSeconds: 1, selfObserved: false, coverage: "unavailable" });
});

test("LMU zero capture UTC uses advancing SDK time and paired source evidence instead of measured zero", () => {
  const observer = new DashboardCaptureObservation("lmu", null);
  const first = lmuPacket(321.5009765625);
  const last = lmuPacket(322.0009765625);
  assert.ok(first.driverActor);
  const bindings = nativeDriverBindings([{ id: "lmu-local", gameId: "lmu", sourceKind: first.driverActor.source,
    nativeIdentity: encodeNativeDriverBinding(first.driverActor), confirmation: "user_confirmed", revision: 1 }]);
  const tracker = new NativeAttributionTracker();
  for (const current of [first, last]) {
    tracker.observe(current, bindings);
    const clock = getNativeSourceClock(current);
    assert.ok(clock);
    observer.observe(current, undefined, undefined,
      { sessionId: clock.sessionId, clockDomain: clock.domain, sourceTimeMs: clock.atMs, stints: tracker.stints });
  }
  assert.deepEqual(observer.toFacts().duration, { status: "available", elapsedSeconds: 0.5,
    attribution: { selfSeconds: 0.5, otherSeconds: 0, unknownSeconds: 0, selfObserved: true, coverage: "complete" } });
});

test("LMU missing SDK time and capture UTC remains unavailable, never a measured zero", () => {
  const observer = new DashboardCaptureObservation("lmu", null);
  const untimed = lmuPacket(Number.NaN);
  assert.equal(untimed.CurrentRaceTime, 0);
  assert.equal(untimed.lmu?.elapsedTime, null);
  observer.observe(untimed, undefined);
  observer.observe(untimed, undefined);
  assert.deepEqual(observer.toFacts().duration, { status: "unavailable", elapsedSeconds: null,
    attribution: { selfSeconds: 0, otherSeconds: 0, unknownSeconds: 0, selfObserved: false, coverage: "unavailable" } });
});
