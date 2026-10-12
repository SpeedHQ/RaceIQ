import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createExperiment, setSessionHead } from "@raceiq/backend-core/db/experiment-queries";
import { createExperimentVersion, getExperimentVersion } from "@raceiq/backend-core/db/experiment-version-queries";
import { insertSession } from "@raceiq/backend-core/db/session-queries";
import { db } from "@raceiq/backend-core/db/index";
import { experimentVersions, experiments, laps, sessions } from "@raceiq/backend-core/db/schema";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { resolveExperimentChatBranch } from "../../src/experiments/chat-branch-context";
import { loadCleanLapAggregate } from "../../src/experiments/lap-evidence/aggregate";
import { loadActiveExperimentContext } from "../../src/experiments/setup-lineage";

const sessionIds: number[] = [];
const raceSessionIds: number[] = [];
const cachedLapIds: number[] = [];
const experimentGames = new Map<number, "acc" | "f1-2025">();
afterEach(async () => {
  for (const id of cachedLapIds.splice(0)) cacheDelete(id);
  for (const id of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.experimentId, id)).run();
    await db.delete(experimentVersions).where(eq(experimentVersions.experimentId, id)).run();
    await db.delete(experiments).where(eq(experiments.id, id)).run();
    experimentGames.delete(id);
  }
  for (const id of raceSessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, id)).run();
});

async function experiment(gameId: "acc" | "f1-2025" = "acc"): Promise<number> {
  const id = await createExperiment({ gameId, name: "chat-branch-evidence" });
  sessionIds.push(id);
  experimentGames.set(id, gameId);
  return id;
}
async function version(experimentId: number, n: number, parentVersionId: number | null = null): Promise<number> {
  return createExperimentVersion({ experimentId, version: n, label: `v${n}`, kind: "setup", parentVersionId });
}
const telemetry: TelemetryPacket[] = Array.from({ length: 30 }, (_, frame) => ({
  gameId: "acc",
  carId: "1",
  trackId: "2",
  CarPerformanceIndex: 0,
  CarClass: 0,
  LapNumber: 1,
  CurrentLap: 1,
  LastLap: 70,
  BestLap: 70,
  CurrentRaceTime: frame * 100,
  DistanceTraveled: frame * 100,
  PositionX: frame,
  PositionY: 0,
  PositionZ: 0,
  Speed: 100 + frame,
  TimestampMS: frame * 100,
} as TelemetryPacket));

async function addLap(sid: number, versionId: number | null, lapTime: number, opts: { valid?: boolean; excluded?: boolean; packetCount?: number; carSetup?: string | null } = {}): Promise<number> {
  const raceId = await insertSession("1", "2", experimentGames.get(sid) ?? "acc");
  raceSessionIds.push(raceId);
  const row = await db.insert(laps).values({
    sessionId: raceId, lapNumber: raceId, lapTime, isValid: opts.valid ?? true,
    rawByteOffset: null, rawFrameCount: 0, experimentId: sid, experimentVersionId: versionId,
    experimentExcluded: opts.excluded ? 1 : 0, carSetup: opts.carSetup ?? null,
  }).returning({ id: laps.id }).get();
  const id = row.id;
  if ((opts.packetCount ?? 30) > 0) { cacheSet(id, telemetry.slice(0, opts.packetCount ?? 30)); cachedLapIds.push(id); }
  return id;
}

describe("chat branch evidence", () => {
  test("empty selected version never borrows sibling or ancestor lap metadata", async () => {
    const sid = await experiment();
    const ancestor = await version(sid, 1);
    const selected = await version(sid, 2, ancestor);
    const sibling = await version(sid, 3, ancestor);
    await setSessionHead(sid, selected);
    await addLap(sid, ancestor, 70);
    await addLap(sid, sibling, 68);
    const resolved = await resolveExperimentChatBranch(sid, selected);
    expect(resolved.ok && resolved.branch.lapIds).toEqual([]);
    const aggregate = await loadCleanLapAggregate(sid, { versionId: selected, lapIds: [], strictBranch: true });
    expect(aggregate).toMatchObject({ ok: false, fallbackSingleLap: false, sourceScope: "branch", headOwnLapCount: 0, lapIds: [], consistency: { cleanLapCount: 0, bestLapSec: null } });
  });

  test("one eligible own lap with telemetry is sole representative and has very-low confidence", async () => {
    const sid = await experiment();
    const selected = await version(sid, 1);
    const sibling = await version(sid, 2);
    await setSessionHead(sid, selected);
    const own = await addLap(sid, selected, 71.25);
    await addLap(sid, sibling, 60);
    const resolved = await resolveExperimentChatBranch(sid, selected);
    if (!resolved.ok) throw new Error(resolved.error);
    const aggregate = await loadCleanLapAggregate(sid, { versionId: resolved.branch.headVersionId, lapIds: resolved.branch.lapIds, strictBranch: true });
    expect(aggregate).toMatchObject({ sourceScope: "branch", lapIds: [own], consistency: { cleanLapCount: 1, bestLapSec: 71.25, confidence: "very-low" } });
  });

  test("invalid, excluded, and thin own laps do not cause sibling evidence fallback", async () => {
    const sid = await experiment();
    const selected = await version(sid, 1);
    const sibling = await version(sid, 2);
    await setSessionHead(sid, selected);
    await addLap(sid, selected, 61, { valid: false });
    await addLap(sid, selected, 62, { excluded: true });
    const thin = await addLap(sid, selected, 63, { packetCount: 2 });
    await addLap(sid, sibling, 55);
    const resolved = await resolveExperimentChatBranch(sid, selected);
    if (!resolved.ok) throw new Error(resolved.error);
    const aggregate = await loadCleanLapAggregate(sid, { versionId: selected, lapIds: resolved.branch.lapIds, strictBranch: true });
    expect(aggregate).toMatchObject({ ok: false, fallbackSingleLap: false, sourceScope: "branch", lapIds: [], consistency: { cleanLapCount: 0, bestLapSec: null } });
    expect(aggregate.lapBreakdown.some((row) => row.lapId === thin)).toBe(true);
  });

  test("resolved lap allowlist remains authoritative after mutable head switches", async () => {
    const sid = await experiment();
    const first = await version(sid, 1);
    const second = await version(sid, 2);
    await setSessionHead(sid, first);
    const allowed = await addLap(sid, first, 72);
    await addLap(sid, second, 58);
    const resolved = await resolveExperimentChatBranch(sid, first);
    if (!resolved.ok) throw new Error(resolved.error);
    await setSessionHead(sid, second);
    const aggregate = await loadCleanLapAggregate(sid, { versionId: resolved.branch.headVersionId, lapIds: resolved.branch.lapIds, strictBranch: true });
    expect(aggregate.lapIds).toEqual([allowed]);
  });

  test("foreign F1 sibling setup cannot populate empty branch or mutate its setup snapshot", async () => {
    const sid = await experiment("f1-2025");
    const selected = await version(sid, 1);
    const sibling = await version(sid, 2);
    await setSessionHead(sid, selected);
    await addLap(sid, sibling, 70, { carSetup: JSON.stringify({ frontWing: 25, rearWing: 30, onThrottle: 55, offThrottle: 65, frontCamber: -3, rearCamber: -1.5, frontToe: 0.05, rearToe: 0.1, frontSuspension: 5, rearSuspension: 6, frontAntiRollBar: 5, rearAntiRollBar: 6, frontRideHeight: 30, rearRideHeight: 45, brakePressure: 90, brakeBias: 55, engineBraking: 50, rearLeftTyrePressure: 22.5, rearRightTyrePressure: 22.5, frontLeftTyrePressure: 23, frontRightTyrePressure: 23, fuelLoad: 50 }) });
    const resolved = await resolveExperimentChatBranch(sid, selected);
    expect(resolved.ok && resolved.branch.setupContext.ok).toBe(false);
    expect((await getExperimentVersion(selected))?.setupSnapshot).toBeNull();
    const reread = await loadActiveExperimentContext(sid, { versionId: selected, lapIds: [] });
    expect(reread.ok).toBe(false);
    expect((await getExperimentVersion(selected))?.setupSnapshot).toBeNull();
  });

  test("null head captures only unversioned F1 setup without selecting latest version", async () => {
    const sid = await experiment("f1-2025");
    const versioned = await version(sid, 1);
    await addLap(sid, versioned, 68, { carSetup: JSON.stringify({ frontWing: 25, rearWing: 30, onThrottle: 55, offThrottle: 65, frontCamber: -3, rearCamber: -1.5, frontToe: 0.05, rearToe: 0.1, frontSuspension: 5, rearSuspension: 6, frontAntiRollBar: 5, rearAntiRollBar: 6, frontRideHeight: 30, rearRideHeight: 45, brakePressure: 90, brakeBias: 55, engineBraking: 50, rearLeftTyrePressure: 22.5, rearRightTyrePressure: 22.5, frontLeftTyrePressure: 23, frontRightTyrePressure: 23, fuelLoad: 50 }) });
    const unversioned = await addLap(sid, null, 72, { carSetup: JSON.stringify({ frontWing: 11, rearWing: 30, onThrottle: 55, offThrottle: 65, frontCamber: -3, rearCamber: -1.5, frontToe: 0.05, rearToe: 0.1, frontSuspension: 5, rearSuspension: 6, frontAntiRollBar: 5, rearAntiRollBar: 6, frontRideHeight: 30, rearRideHeight: 45, brakePressure: 90, brakeBias: 55, engineBraking: 50, rearLeftTyrePressure: 22.5, rearRightTyrePressure: 22.5, frontLeftTyrePressure: 23, frontRightTyrePressure: 23, fuelLoad: 50 }) });
    await setSessionHead(sid, null);
    const resolved = await resolveExperimentChatBranch(sid, null);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.branch.lapIds).toEqual([unversioned]);
    expect(resolved.branch.activeVersion).toBeNull();
    expect(resolved.branch.setupContext).toMatchObject({ ok: true, setup: { frontWing: 11 } });
  });
});
