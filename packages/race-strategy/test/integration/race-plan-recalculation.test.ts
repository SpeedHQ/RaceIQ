import { afterEach, describe, expect, test } from "bun:test";
import { insertSession, deleteSession } from "@raceiq/backend-core/db/session-queries";
import { client } from "@raceiq/backend-core/db/index";
import { createRacePlan, deleteRacePlan, recalculateRacePlan, RacePlanEvidenceUnavailableError, racePlanRoutes } from "@raceiq/race-strategy/server";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { generateRacePlanStints } from "@raceiq/race-strategy/contracts";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { initStrategyTestAdapters } from "../support/init";

initStrategyTestAdapters();

const sessions: number[] = [];
const plans: string[] = [];
afterEach(async () => { for (const id of plans.splice(0)) await deleteRacePlan(id); for (const id of sessions.splice(0)) await deleteSession(id); });

function evidence(id: string, sessionId: number, gameId = "fm-2023", startedAt = "2026-01-01T00:00:00.000Z",
  compound = "medium", pace = 60, completedLaps = 10, weather: string | null = null): StintSummary {
  return {
    id, sessionId, driverKey: "local-player", ordinal: 1, status: "completed", gameId: gameId as StintSummary["gameId"],
    trackId: "5", carId: "642", pi: gameId === "fm-2023" ? 800 : null, compounds: [compound, compound, compound, compound],
    compatibility: { fuelSemanticVersion: "fuel-v1", tireSemanticVersions: ["tire-v1", "tire-v1", "tire-v1", "tire-v1"], virtualEnergySemanticVersion: gameId === "lmu" ? "energy-v1" : null, setupKey: "setup", conditions: { weather, airTemperatureC: null, trackTemperatureC: null } },
    startedAt, endedAt: startedAt, firstLapNumber: 1, lastLapNumber: completedLaps, boundary: { reason: "pit", confidence: "observed" }, completedLaps,
    fuel: { value: 0.1, unit: "L/lap", eligibleLaps: 10, source: "history", provisional: false, unavailableReason: null },
    tires: [0, 1, 2, 3].map(() => ({ value: 0.001, unit: "wearFraction/lap" as const, eligibleLaps: 10, source: "history" as const, provisional: false, unavailableReason: null })) as StintSummary["tires"],
    virtualEnergy: gameId === "lmu" ? { value: 0.1, unit: "energyFraction/lap", eligibleLaps: 10, source: "history", provisional: false, unavailableReason: null } : undefined,
    measuredFuelUsed: 1, fuelUnit: "L", fuelCoverage: "complete", averageLapSeconds: pace, paceLaps: 10, exclusions: [], algorithmVersion: "test", revision: 1,
  };
}
async function addSource({ newer = false, gameId = "fm-2023", fuel = 0.1, status = "completed", compound = "medium",
  pace = 60, completedLaps = 10, weather = null }: { newer?: boolean; gameId?: string; fuel?: number; status?: string; compound?: string; pace?: number; completedLaps?: number; weather?: string | null } = {}) {
  const sessionId = await insertSession("642", "5", gameId, undefined, undefined, "mine"); sessions.push(sessionId);
  const id = `recalc-${sessionId}`;
  const source = { ...evidence(id, sessionId, gameId, newer ? "2026-02-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z", compound, pace, completedLaps, weather),
    fuel: { ...evidence(id, sessionId, gameId).fuel, value: fuel }, status: status as StintSummary["status"] };
  await client.execute({ sql: "UPDATE sessions SET created_at=? WHERE id=?", args: [source.startedAt, sessionId] });
  await client.execute({ sql: "INSERT INTO strategy_stints(id,session_id,driver_key,ordinal,status,payload) VALUES(?,?,?,?,?,?)", args: [id, sessionId, "local-player", 1, status, JSON.stringify(source)] });
  return source;
}
async function makePlan(source: StintSummary, raceLength: unknown = { mode: "laps" },
  stints: { endLap: number; compounds: string[]; sourceSessionId: number; sourceStintId: string }[] = [{
    endLap: 20, compounds: [...source.compounds], sourceSessionId: source.sessionId, sourceStintId: source.id,
  }]) {
  const saved = await createRacePlan({ name: "Saved", gameId: source.gameId, carId: source.carId, trackId: source.trackId, pi: source.pi,
    totalLaps: 20, raceLength, fuelUnit: "L", notes: "unchanged", generation: null,
    stints: stints.map((stint) => ({ ...stint, startFuel: 5 })) });
  plans.push(saved.id); return saved;
}

describe("race plan recalculation", () => {
  test("uses newer improved evidence and returns read-only proposal", async () => {
    const old = await addSource(); const saved = await makePlan(old);
    const newer = await addSource({ newer: true, fuel: 0.05 });
    const activeBefore = await client.execute("SELECT game_id, car_id, track_id, plan_id FROM active_race_plans ORDER BY game_id, car_id, track_id");
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.sources.map((item) => item.id)).toEqual([newer.id]);
    expect(result.draft.stints.at(-1)?.endLap).toBe(20);
    expect(result.draft.stints[0]?.sourceStintId).toBe(newer.id);
    expect(result.draft.stints.length).toBe(1);
    expect((await client.execute({ sql: "SELECT payload FROM race_plans WHERE id=?", args: [saved.id] })).rows[0]?.payload).toEqual(expect.any(String));
    const response = await racePlanRoutes.request(`/api/race-plans/${saved.id}/recalculate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } }),
    });
    expect(response.status).toBe(200);
    const routeBody = await response.json() as { draft: { totalLaps: number } };
    expect(routeBody.draft.totalLaps).toBe(20);
    expect(await client.execute("SELECT game_id, car_id, track_id, plan_id FROM active_race_plans ORDER BY game_id, car_id, track_id")).toEqual(activeBefore);
  });
  test("legacy recalculation still finds matching evidence older than five incompatible sessions", async () => {
    const original = await addSource();
    const saved = await makePlan(original);
    for (let index = 0; index < 6; index++) await addSource({ newer: true, compound: "soft" });
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.sources.map((item) => item.id)).toEqual([original.id]);
  });
  test("recalculates aggregate plans from latest compatible multi-session rates", async () => {
    const first = await addSource({ fuel: 0.1 });
    const second = await addSource({ fuel: 0.05 });
    const saved = await createRacePlan({ name: "Aggregate", gameId: first.gameId, carId: first.carId, trackId: first.trackId, pi: first.pi,
      totalLaps: 20, raceLength: { mode: "laps" }, fuelUnit: "L", notes: "", weather: "any",
      stints: [{ endLap: 20, startFuel: 5, compounds: [...first.compounds], sourceSessionId: null, sourceStintId: null,
        sourceStints: [{ sessionId: first.sessionId, stintId: first.id }, { sessionId: second.sessionId, stintId: second.id }] }] });
    plans.push(saved.id);
    const newerFirst = await addSource({ newer: true, fuel: 0.02 });
    const newerSecond = await addSource({ newer: true, fuel: 0.04 });
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.sources.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, second.id, newerFirst.id, newerSecond.id]));
    expect(result.sources).toHaveLength(4);
    expect(result.draft.stints[0]?.sourceSessionId).toBeNull();
    expect(result.draft.stints[0]?.sourceStints).toHaveLength(4);
  });
  test("filters requested weather before 100-source cap", async () => {
    const dry = await addSource({ fuel: 0.04, weather: "2" });
    const saved = await createRacePlan({ name: "Dry aggregate", gameId: dry.gameId, carId: dry.carId, trackId: dry.trackId, pi: dry.pi,
      totalLaps: 20, raceLength: { mode: "laps" }, fuelUnit: "L", notes: "", weather: "dry",
      stints: [{ endLap: 20, startFuel: 5, compounds: [...dry.compounds], sourceSessionId: null, sourceStintId: null,
        sourceStints: [{ sessionId: dry.sessionId, stintId: dry.id }] }] });
    plans.push(saved.id);
    const wetSession = await insertSession("642", "5", dry.gameId, undefined, undefined, "mine");
    sessions.push(wetSession);
    const wet = evidence("unused", wetSession, dry.gameId, "2026-02-01T00:00:00.000Z", "medium", 60, 10, "5");
    await client.execute({ sql: "UPDATE sessions SET created_at=? WHERE id=?", args: [wet.startedAt, wetSession] });
    const drySources = [];
    for (let index = 0; index < 101; index++) {
      const wetSource = { ...wet, id: `wet-${wetSession}-${index}`, ordinal: index + 203,
        fuel: { ...wet.fuel, value: 0.2, eligibleLaps: 10 } };
      const drySource = { ...wet, id: `dry-${wetSession}-${index}`, ordinal: index + 102,
        compatibility: { ...wet.compatibility, conditions: { ...wet.compatibility.conditions, weather: "2" } },
        fuel: { ...wet.fuel, value: index === 0 ? 0.8 : 0.02, eligibleLaps: 10 } };
      drySources.push(drySource);
      for (const source of [wetSource, drySource]) await client.execute({ sql: "INSERT INTO strategy_stints(id,session_id,driver_key,ordinal,status,payload) VALUES(?,?,?,?,?,?)",
        args: [source.id, wetSession, "local-player", source.ordinal, "completed", JSON.stringify(source)] });
    }
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.sources.map((item) => item.id)).toEqual(drySources.slice(1).reverse().map((item) => item.id));
    expect(result.draft.stints[0]?.sourceStints).toEqual(drySources.slice(1).reverse().map((item) => ({ sessionId: wetSession, stintId: item.id })));
    expect(result.draft.stints[0]?.startFuel).toBeCloseTo(1.4);
  });

  test("rejects when no compatible measured source exists", async () => {
    const source = await addSource(); const saved = await makePlan(source);
    const unavailable = { ...source, fuel: { ...source.fuel, value: null, eligibleLaps: 0 } };
    await client.execute({ sql: "UPDATE strategy_stints SET payload=? WHERE id=?", args: [JSON.stringify(unavailable), source.id] });
    await expect(recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } })).rejects.toBeInstanceOf(RacePlanEvidenceUnavailableError);
  });
  test("skips source with changed measurement semantics", async () => {
    const original = await addSource();
    const saved = await makePlan(original);
    const incompatible = await addSource({ newer: true, fuel: 0.05 });
    incompatible.compatibility.fuelSemanticVersion = "fuel-v2";
    await client.execute({ sql: "UPDATE strategy_stints SET payload=? WHERE id=?", args: [JSON.stringify(incompatible), incompatible.id] });
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.sources.map((item) => item.id)).toEqual([original.id]);
  });
  test("rejects payload identity differing from authoritative stint row", async () => {
    const original = await addSource();
    const saved = await makePlan(original);
    const mismatched = await addSource({ newer: true });
    mismatched.id = "forged-summary-id";
    await client.execute({ sql: "UPDATE strategy_stints SET payload=? WHERE id=?", args: [JSON.stringify(mismatched), `recalc-${mismatched.sessionId}`] });
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.sources.map((item) => item.id)).toEqual([original.id]);
  });
  test("retains mixed-compound anchor and weights timed pace by original phase laps", async () => {
    const first = await addSource({ compound: "medium", pace: 60, completedLaps: 2 });
    const second = await addSource({ compound: "soft", pace: 120, completedLaps: 100 });
    const saved = await makePlan(first, { mode: "time", durationSeconds: 1200, averageLapSeconds: 60 }, [
      { endLap: 10, compounds: [...first.compounds], sourceSessionId: first.sessionId, sourceStintId: first.id },
      { endLap: 20, compounds: [...second.compounds], sourceSessionId: second.sessionId, sourceStintId: second.id },
    ]);
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } });
    expect(result.draft.raceLength).toEqual({ mode: "time", durationSeconds: 1200, averageLapSeconds: 90 });
    expect(result.draft.totalLaps).toBe(14);
    expect(result.draft.stints.map((stint) => stint.endLap)).toEqual([10, 14]);
    expect(result.draft.stints.map((stint) => stint.compounds[0])).toEqual(["medium", "soft"]);
  });
  test("rejects timed recalculation when retained compound anchor cannot fit", async () => {
    const first = await addSource({ compound: "medium", pace: 60 });
    const second = await addSource({ compound: "soft", pace: 180 });
    const saved = await makePlan(first, { mode: "time", durationSeconds: 1200, averageLapSeconds: 60 }, [
      { endLap: 10, compounds: [...first.compounds], sourceSessionId: first.sessionId, sourceStintId: first.id },
      { endLap: 20, compounds: [...second.compounds], sourceSessionId: second.sessionId, sourceStintId: second.id },
    ]);
    await expect(recalculateRacePlan(saved.id, { generation: { fuelCapacity: 10, fuelReserve: 1, energyReserveFraction: 0 } }))
      .rejects.toBeInstanceOf(RacePlanEvidenceUnavailableError);
  });
  test("LMU virtual energy limits stints independently", async () => {
    const source = evidence("energy", 1, "lmu");
    const generated = generateRacePlanStints(source, 20, 100, 0, () => ({ cliffPct: 40, deadPct: 20 }), 0.5);
    expect(generated?.[0]?.endLap).toBe(5);
    const unavailable = { ...source, virtualEnergy: undefined };
    expect(generateRacePlanStints(unavailable, 20, 100, 0, () => ({ cliffPct: 40, deadPct: 20 }))).toBeNull();
  });
  test("F1 carries initial fuel across compound phases without refueling", async () => {
    const first = await addSource({ gameId: "f1-2025", compound: "medium", fuel: 0.1, completedLaps: 20 });
    const second = await addSource({ gameId: "f1-2025", compound: "soft", fuel: 0.1, completedLaps: 20 });
    const saved = await makePlan(first, { mode: "laps" }, [
      { endLap: 10, compounds: [...first.compounds], sourceSessionId: first.sessionId, sourceStintId: first.id },
      { endLap: 20, compounds: [...second.compounds], sourceSessionId: second.sessionId, sourceStintId: second.id },
    ]);
    const result = await recalculateRacePlan(saved.id, { generation: { fuelCapacity: 5, fuelReserve: 0, energyReserveFraction: 0 } });
    expect(result.draft.stints.map((stint) => stint.startFuel)).toEqual([5, 4]);
  });
  test("F1 rejects whole-race fuel demand beyond initial capacity", async () => {
    const source = await addSource({ gameId: "f1-2025", fuel: 0.3 });
    const saved = await makePlan(source);
    await expect(recalculateRacePlan(saved.id, { generation: { fuelCapacity: 5, fuelReserve: 0, energyReserveFraction: 0 } }))
      .rejects.toBeInstanceOf(RacePlanEvidenceUnavailableError);
  });
});
