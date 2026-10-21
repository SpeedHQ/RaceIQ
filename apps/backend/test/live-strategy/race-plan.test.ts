import { afterEach, describe, expect, test } from "bun:test";
import { insertSession, deleteSession } from "@raceiq/backend-core/db/session-queries";
import { client } from "@raceiq/backend-core/db/index";
import {
  createRacePlan,
  deleteRacePlan,
  getActiveRacePlan,
  InvalidRacePlanSourceError,
  listRacePlans,
  setActiveRacePlan,
  updateRacePlan,
} from "@raceiq/backend-core/db/race-plan-queries";

const sourceEvidence = {
  id: "",
  sessionId: 0,
  driverKey: "local-player",
  ordinal: 1,
  status: "completed",
  gameId: "fm-2023",
  trackId: "5",
  carId: "642",
  pi: 800,
  compounds: [null, null, null, null],
  compatibility: {
    fuelSemanticVersion: null,
    tireSemanticVersions: [null, null, null, null],
    setupKey: null,
    conditions: { weather: null, airTemperatureC: null, trackTemperatureC: null },
  },
  startedAt: "2025-01-01T00:00:00.000Z",
  endedAt: "2025-01-01T00:10:00.000Z",
  firstLapNumber: 1,
  lastLapNumber: 10,
  boundary: { reason: "pit-visit", confidence: "observed" },
  completedLaps: 10,
  fuel: { value: 0, unit: "tankFraction/lap", eligibleLaps: 10, source: "history", provisional: false, unavailableReason: null },
  tires: [0, 1, 2, 3].map(() => ({ value: null, unit: "wearFraction/lap", eligibleLaps: 0, source: null, provisional: false, unavailableReason: "no-data" })),
  measuredFuelUsed: 0,
  fuelUnit: "tankFraction",
  fuelCoverage: "complete",
  averageLapSeconds: 60,
  paceLaps: 10,
  exclusions: [],
  algorithmVersion: "race-plan-test",
  revision: 1,
} as const;

function planInput(sessionId: number) {
  return {
    name: "  Race plan  ", gameId: "fm-2023", carId: "642", trackId: "5", pi: 800,
    totalLaps: 10, fuelUnit: "tankFraction", notes: "", stints: [{
      endLap: 10, startFuel: 0, compounds: [null, null, null, null], sourceSessionId: sessionId, sourceStintId: `race-plan-source-${sessionId}`,
    }],
  };
}

const sessions: number[] = [];
const plans: string[] = [];
afterEach(async () => {
  for (const id of plans.splice(0)) await deleteRacePlan(id);
  for (const id of sessions.splice(0)) await deleteSession(id);
});

async function sourceSession(): Promise<number> {
  const id = await insertSession("642", "5", "fm-2023", undefined, undefined, "mine");
  sessions.push(id);
  await client.execute({
    sql: "INSERT INTO strategy_stints(id, session_id, driver_key, ordinal, status, payload) VALUES(?,?,?,?,?,?)",
    args: [`race-plan-source-${id}`, id, "local-player", 1, "completed", JSON.stringify({ ...sourceEvidence, id: `race-plan-source-${id}`, sessionId: id })],
  });
  return id;
}

describe("saved race plan persistence", () => {
  test("freezes owned source evidence, preserves zero and null, and survives source deletion", async () => {
    const sessionId = await sourceSession();
    const created = await createRacePlan(planInput(sessionId));
    plans.push(created.id);
    expect(created.name).toBe("Race plan");
    expect(created.stints[0]?.startFuel).toBe(0);
    expect(created.stints[0]?.evidence?.fuel.value).toBe(0);
    expect(created.stints[0]?.evidence?.tires[0]?.value).toBeNull();

    await deleteSession(sessionId);
    sessions.splice(sessions.indexOf(sessionId), 1);
    const saved = await listRacePlans("fm-2023");
    expect(saved.find(({ id }) => id === created.id)?.stints[0]?.evidence?.sessionId).toBe(sessionId);
  });

  test("rejects incompatible source without changing existing plan and clears active on deletion", async () => {
    const sessionId = await sourceSession();
    const created = await createRacePlan(planInput(sessionId));
    plans.push(created.id);
    await setActiveRacePlan(created.id);
    const invalid = { ...planInput(sessionId), stints: [{ ...planInput(sessionId).stints[0]!, compounds: ["soft", null, null, null] as [string | null, string | null, string | null, string | null] }] };
    await expect(updateRacePlan(created.id, invalid)).rejects.toBeInstanceOf(InvalidRacePlanSourceError);
    expect((await listRacePlans("fm-2023")).find(({ id }) => id === created.id)?.stints[0]?.compounds[0]).toBeNull();

    expect(await deleteRacePlan(created.id)).toBe(true);
    plans.splice(plans.indexOf(created.id), 1);
    expect(await getActiveRacePlan()).toBeNull();
    expect(await deleteRacePlan(created.id)).toBe(false);
  });

  test("rejects mismatched or non-owned sources and enforces stint boundaries", async () => {
    const sessionId = await sourceSession();
    const mismatchedIdentity = { ...planInput(sessionId), carId: "other" };
    await expect(createRacePlan(mismatchedIdentity)).rejects.toBeInstanceOf(InvalidRacePlanSourceError);
    const invalidOrder = { ...planInput(sessionId), totalLaps: 20, stints: [
      { ...planInput(sessionId).stints[0], endLap: 11 },
      { ...planInput(sessionId).stints[0], endLap: 10 },
    ] };
    await expect(createRacePlan(invalidOrder)).rejects.toThrow();

    await client.execute({ sql: "UPDATE sessions SET ownership='others' WHERE id=?", args: [sessionId] });
    await expect(createRacePlan(planInput(sessionId))).rejects.toThrow();
  });
});
