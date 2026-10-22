import { afterEach, describe, expect, test } from "bun:test";
import { insertSession, deleteSession } from "@raceiq/backend-core/db/session-queries";
import { client } from "@raceiq/backend-core/db/index";
import { migrations } from "@raceiq/backend-core/db/migrations";
import { bootstrap, newClient, runMigrations } from "@raceiq/backend-core/test-support/db/migrations";
import {
  createRacePlan,
  deleteRacePlan,
  getActiveRacePlans,
  InvalidRacePlanError,
  InvalidRacePlanSourceError,
  listRacePlans,
  racePlanRoutes,
  setActiveRacePlan,
  updateRacePlan,
} from "@raceiq/race-strategy/server";
import { estimateRaceLaps, RacePlanInputSchema } from "@raceiq/shared/racing/live/race-plan";


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
    await setActiveRacePlan({ gameId: created.gameId, carId: created.carId, trackId: created.trackId, planId: created.id });
    const invalid = { ...planInput(sessionId), stints: [{ ...planInput(sessionId).stints[0]!, compounds: ["soft", null, null, null] as [string | null, string | null, string | null, string | null] }] };
    await expect(updateRacePlan(created.id, invalid)).rejects.toBeInstanceOf(InvalidRacePlanSourceError);
    expect((await listRacePlans("fm-2023")).find(({ id }) => id === created.id)?.stints[0]?.compounds[0]).toBeNull();

    expect(await deleteRacePlan(created.id)).toBe(true);
    plans.splice(plans.indexOf(created.id), 1);
    expect(await getActiveRacePlans()).toEqual([]);
    expect(await deleteRacePlan(created.id)).toBe(false);
  });

  test("pins remain independent per combo; wrong tuple writes nothing; unload and identity edits clear only prior pin", async () => {
    const input = {
      name: "Pinned", gameId: "fm-2023", carId: "642", trackId: "5", pi: null,
      totalLaps: 2, fuelUnit: "tankFraction", notes: "", stints: [
        { endLap: 2, startFuel: null, compounds: [null, null, null, null] as [null, null, null, null], sourceSessionId: null, sourceStintId: null },
      ],
    };
    const a = await createRacePlan(input);
    const replacement = await createRacePlan(input);
    const b = await createRacePlan({ ...input, carId: "other-car" });
    plans.push(a.id, replacement.id, b.id);
    const comboA = { gameId: a.gameId, carId: a.carId, trackId: a.trackId };
    const comboB = { gameId: b.gameId, carId: b.carId, trackId: b.trackId };
    await setActiveRacePlan({ ...comboA, planId: a.id });
    await setActiveRacePlan({ ...comboB, planId: b.id });
    await setActiveRacePlan({ ...comboA, planId: replacement.id });
    expect((await getActiveRacePlans()).map(({ id }) => id)).toEqual([replacement.id, b.id]);
    const mismatch = await racePlanRoutes.request("/api/race-plans/active", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...comboB, trackId: "wrong", planId: b.id }),
    });
    expect(mismatch.status).toBe(400);
    const missing = await racePlanRoutes.request("/api/race-plans/active", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...comboB, planId: "absent-plan" }),
    });
    expect(missing.status).toBe(404);
    expect((await racePlanRoutes.request("/api/race-plans/active")).status).toBe(200);
    expect((await getActiveRacePlans()).map(({ id }) => id)).toEqual([replacement.id, b.id]);
    await setActiveRacePlan({ ...comboA, planId: null });
    expect((await getActiveRacePlans()).map(({ id }) => id)).toEqual([b.id]);
    await updateRacePlan(b.id, { ...input, carId: "changed-car" });
    expect(await getActiveRacePlans()).toEqual([]);
  });

  test("migration preserves singleton pin identity and drops legacy selection table", async () => {
    const migrationClient = newClient();
    try {
      await bootstrap(migrationClient);
      await migrationClient.execute("CREATE TABLE race_plans (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, car_id TEXT NOT NULL, track_id TEXT NOT NULL, pi REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL)");
      await migrationClient.execute("CREATE TABLE active_race_plan (id INTEGER PRIMARY KEY CHECK(id=1), plan_id TEXT REFERENCES race_plans(id) ON DELETE SET NULL)");
      await migrationClient.execute("INSERT INTO race_plans VALUES ('legacy-plan','fm-2023','old-car','old-track',NULL,'x','x','{}')");
      await migrationClient.execute("INSERT INTO active_race_plan VALUES (1,'legacy-plan')");
      await migrationClient.execute({ sql: "INSERT INTO schema_migrations(version,name) VALUES(83,?)", args: ["persist saved race plans"] });
      const version83 = migrations.find(({ version }) => version === 83)!;
      const version85 = migrations.find(({ version }) => version === 85)!;
      expect(await runMigrations(migrationClient, 85, [version83, version85])).toBe(1);
      expect(await migrationClient.execute("SELECT game_id,car_id,track_id,plan_id FROM active_race_plans")).toMatchObject({
        rows: [{ game_id: "fm-2023", car_id: "old-car", track_id: "old-track", plan_id: "legacy-plan" }],
      });
      await expect(migrationClient.execute("SELECT * FROM active_race_plan")).rejects.toThrow();
    } finally {
      migrationClient.close();
    }
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
  test("estimates timed race laps at exact and partial boundaries without accepting invalid inputs", () => {
    expect(estimateRaceLaps(1800, 90)).toBe(20);
    expect(estimateRaceLaps(1801, 90)).toBe(21);
    expect(estimateRaceLaps(90, 90)).toBe(1);
    expect(estimateRaceLaps(1, 90)).toBe(1);
    for (const [duration, pace] of [[0, 90], [-1, 90], [1800, 0], [1800, -1], [Infinity, 90], [1800, NaN], [604801, 90], [1800, 86401], [10001, 1]]) {
      expect(estimateRaceLaps(duration!, pace!)).toBeNull();
    }
  });

  test("persists timed length and rejects inconsistent edits without mutating the saved plan", async () => {
    const sessionId = await sourceSession();
    const input = { ...planInput(sessionId), raceLength: { mode: "time" as const, durationSeconds: 600, averageLapSeconds: 60 } };
    const created = await createRacePlan(input);
    plans.push(created.id);
    expect(created.raceLength).toEqual(input.raceLength);
    await setActiveRacePlan({ gameId: created.gameId, carId: created.carId, trackId: created.trackId, planId: created.id });
    expect((await getActiveRacePlans()).map((plan) => plan.raceLength)).toEqual([input.raceLength]);
    expect((await listRacePlans("fm-2023")).find((plan) => plan.id === created.id)).toEqual(created);
    await expect(updateRacePlan(created.id, { ...input, raceLength: { ...input.raceLength, durationSeconds: 601 } })).rejects.toThrow();
    expect((await listRacePlans("fm-2023")).find((plan) => plan.id === created.id)).toEqual(created);
    expect(RacePlanInputSchema.safeParse({ ...input, raceLength: { mode: "time", durationSeconds: 600, averageLapSeconds: 0 } }).success).toBe(false);
  });

  test("reads old saved lap plans without a race-length object", async () => {
    const sessionId = await sourceSession();
    const created = await createRacePlan(planInput(sessionId));
    plans.push(created.id);
    const { raceLength: _raceLength, ...legacy } = created;
    await client.execute({ sql: "UPDATE race_plans SET payload=? WHERE id=?", args: [JSON.stringify(legacy), created.id] });
    expect((await listRacePlans("fm-2023")).find((plan) => plan.id === created.id)?.raceLength).toEqual({ mode: "laps" });
  });
});
