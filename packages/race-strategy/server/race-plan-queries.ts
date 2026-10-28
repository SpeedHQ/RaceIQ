import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import {
  RacePlanInputSchema,
  RacePlanSchema,
  type RacePlan,
  type RacePlanInput,
  type RacePlanStint,
  type SetActiveRacePlanInput,
} from "@raceiq/shared/racing/live/race-plan";
import { StintSummarySchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { RacePlanBaselineSchema, type RacePlanWeather, type RacePlanBaseline } from "@raceiq/shared/racing/live/race-plan";
import { aggregateRacePlanEvidence, classifyRacePlanWeather } from "@raceiq/shared/racing/live/race-plan-evidence";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { client } from "@raceiq/backend-core/db/index";
import { withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";
import { isRecordingSession } from "@raceiq/backend-core/telemetry/live-pipeline";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";

export class RacePlanNotFoundError extends Error {}
export class RacePlanSourceNotFoundError extends Error {}
export class InvalidRacePlanSourceError extends Error {}
export class InvalidRacePlanError extends Error {}

/** Coordinate with live capture without wrapping domain errors in Effect failures. */
async function racePlanTransaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
  const result = await withDatabaseWrite(async () => {
    const tx = await client.transaction("write");
    try {
      const value = await operation(tx);
      await tx.commit();
      return { ok: true as const, value };
    } catch (error) {
      await tx.rollback();
      return { ok: false as const, error };
    } finally {
      await tx.close();
    }
  }, undefined, "race-plan.write");
  if (!result.ok) throw result.error;
  return result.value;
}

function parsePlan(payload: unknown): RacePlan {
  return RacePlanSchema.parse(JSON.parse(String(payload)));
}

async function resolveEvidence(tx: Transaction, input: RacePlanInput, previous?: RacePlan): Promise<RacePlanStint[]> {
  const output: RacePlanStint[] = [];
  for (const stint of input.stints) {
    const refs = stint.sourceStints ?? (stint.sourceSessionId !== null && stint.sourceStintId !== null
      ? [{ sessionId: stint.sourceSessionId, stintId: stint.sourceStintId }] : []);
    const prior = previous && (previous.weather ?? "any") === (input.weather ?? "any") &&
      previous.gameId === input.gameId && previous.carId === input.carId && previous.trackId === input.trackId &&
      previous.pi === input.pi && previous.fuelUnit === input.fuelUnit ? previous.stints.find((saved) =>
        JSON.stringify(saved.compounds) === JSON.stringify(stint.compounds) &&
        JSON.stringify(saved.sourceStints ?? []) === JSON.stringify(stint.sourceStints ?? []) &&
        saved.sourceSessionId === stint.sourceSessionId && saved.sourceStintId === stint.sourceStintId) : undefined;
    if (!refs.length) {
      output.push({ ...stint, compounds: [...stint.compounds], evidence: null, baseline: null });
      continue;
    }
    if (stint.sourceStints && prior?.baseline) {
      output.push({ ...stint, compounds: [...stint.compounds], evidence: null, baseline: prior.baseline });
      continue;
    }
    const sources: StintSummary[] = [];
    for (const ref of refs) {
      const result = await tx.execute({
        sql: `SELECT st.payload, st.driver_key, st.status, s.game_id, s.car_id, s.track_id, s.ownership
          FROM strategy_stints st JOIN sessions s ON s.id=st.session_id
          WHERE st.id=? AND st.session_id=? AND st.status IN ('completed','interrupted')
            AND (?=0 OR NOT EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=s.id)
              OR EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=s.id AND c.status='sealed'))`,
        args: [ref.stintId, ref.sessionId, stint.sourceStints ? 1 : 0],
      });
      const row = result.rows[0];
      if (!row || row.ownership !== "mine") throw new RacePlanSourceNotFoundError();
      let evidence: StintSummary;
      try { evidence = StintSummarySchema.parse(JSON.parse(String(row.payload))); }
      catch { throw new InvalidRacePlanSourceError(); }
      if (stint.sourceStints && isRecordingSession(ref.sessionId)) throw new InvalidRacePlanSourceError();
      if (row.game_id !== input.gameId || row.car_id !== input.carId || row.track_id !== input.trackId ||
          evidence.gameId !== input.gameId || evidence.carId !== input.carId || evidence.trackId !== input.trackId ||
          evidence.sessionId !== ref.sessionId || evidence.id !== ref.stintId || evidence.driverKey !== row.driver_key ||
          (stint.sourceStints && evidence.driverKey !== "local-player") ||
          evidence.status !== row.status || evidence.status === "active" || evidence.endedAt === null ||
          evidence.fuelUnit !== input.fuelUnit || evidence.pi !== input.pi ||
          (input.gameId === "fm-2023" && (input.pi === null || evidence.pi === null)) ||
          evidence.compounds.some((compound, index) => compound !== stint.compounds[index]) ||
          (stint.sourceStints && (evidence.fuel.value === null || evidence.fuel.value < 0 || evidence.fuel.eligibleLaps < 1 ||
            evidence.fuel.unit !== (input.fuelUnit === "L" ? "L/lap" : "tankFraction/lap") ||
            evidence.tires.some((rate) => rate.value === null || rate.value < 0 || rate.eligibleLaps < 1 || rate.unit !== "wearFraction/lap")))) {
        throw new InvalidRacePlanSourceError();
      }
      sources.push(evidence);
    }
    if (stint.sourceStints) {
      const baseline = aggregateRacePlanEvidence(sources, input.weather ?? "any");
      if (!baseline || baseline.sources.length !== sources.length) throw new InvalidRacePlanSourceError();
      output.push({ ...stint, compounds: [...stint.compounds], evidence: null, baseline: RacePlanBaselineSchema.parse(baseline) });
    } else {
      output.push({ ...stint, compounds: [...stint.compounds], evidence: sources[0]!, baseline: null });
    }
  }
  return output;
}

async function persist(tx: Transaction, id: string, input: RacePlanInput, createdAt: string, updatedAt: string, previous?: RacePlan): Promise<RacePlan> {
  const stints = await resolveEvidence(tx, input, previous);
  const plan = RacePlanSchema.parse({ ...input, id, createdAt, updatedAt, stints });
  await tx.execute({
    sql: `INSERT INTO race_plans(id, game_id, car_id, track_id, pi, created_at, updated_at, payload)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET game_id=excluded.game_id,car_id=excluded.car_id,
      track_id=excluded.track_id,pi=excluded.pi,updated_at=excluded.updated_at,payload=excluded.payload`,
    args: [id, plan.gameId, plan.carId, plan.trackId, plan.pi, createdAt, updatedAt, JSON.stringify(plan)],
  });
  return plan;
}

export async function getRacePlanGenerationEvidence(input: { gameId: string; carId: string; trackId: string; weather: RacePlanWeather }): Promise<RacePlanBaseline | null> {
  return withSessionCaptureMaintenanceLock(async () => {
    const sessions = await client.execute({
      sql: `SELECT s.id, s.created_at FROM sessions s WHERE s.game_id=? AND s.car_id=? AND s.track_id=? AND s.ownership='mine'
        AND (NOT EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=s.id)
          OR EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=s.id AND c.status='sealed'))
        ORDER BY s.created_at DESC,s.id DESC`,
      args: [input.gameId, input.carId, input.trackId],
    });
  const sessionIds = sessions.rows.filter((row) => !isRecordingSession(Number(row.id))).slice(0, 5).map((row) => Number(row.id));
  if (!sessionIds.length) return null;
  const result = await client.execute({
    sql: `SELECT st.id, st.session_id, st.payload, st.driver_key, st.status, s.game_id, s.car_id, s.track_id
      FROM strategy_stints st JOIN sessions s ON s.id=st.session_id
      WHERE st.session_id IN (${sessionIds.map(() => "?").join(",")}) AND st.driver_key='local-player'
        AND st.status IN ('completed','interrupted')
      ORDER BY s.created_at DESC,s.id DESC,st.ordinal DESC,st.id ASC`,
    args: sessionIds,
  });
  const candidates: StintSummary[] = [];
  for (const row of result.rows) {
    try {
      const evidence = StintSummarySchema.parse(JSON.parse(String(row.payload)));
      if (evidence.status === "active" || evidence.status !== row.status || evidence.endedAt === null || evidence.sessionId !== Number(row.session_id) ||
          evidence.id !== String(row.id) || evidence.driverKey !== String(row.driver_key) ||
          row.game_id !== input.gameId || row.car_id !== input.carId || row.track_id !== input.trackId ||
          evidence.gameId !== input.gameId || evidence.carId !== input.carId || evidence.trackId !== input.trackId ||
          evidence.fuel.value === null || evidence.fuel.eligibleLaps < 1 ||
          evidence.fuel.unit !== (evidence.fuelUnit === "L" ? "L/lap" : "tankFraction/lap") ||
          evidence.tires.some((rate) => rate.value === null || rate.value < 0 || rate.eligibleLaps < 1 || rate.unit !== "wearFraction/lap") ||
          evidence.fuel.value < 0 || evidence.compounds.some((compound) => compound === null) ||
          evidence.compatibility.fuelSemanticVersion === null || evidence.compatibility.tireSemanticVersions.some((version) => version === null) ||
          evidence.gameId === "fm-2023" && evidence.pi === null ||
          evidence.gameId === "lmu" && (evidence.compatibility.virtualEnergySemanticVersion == null || evidence.virtualEnergy == null ||
            evidence.virtualEnergy.value === null || evidence.virtualEnergy.value < 0 || evidence.virtualEnergy.eligibleLaps < 1 ||
            evidence.virtualEnergy.unit !== "energyFraction/lap")) continue;
      const category = classifyRacePlanWeather(evidence.compatibility.conditions.weather);
      if (input.weather !== "any" && category !== input.weather) continue;
      candidates.push(evidence);
      if (candidates.length === 100) break;
    } catch { /* malformed historical evidence is unavailable */ }
  }
  return aggregateRacePlanEvidence(candidates, input.weather);
  });
}

export async function listRacePlans(gameId: string): Promise<RacePlan[]> {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (!parsedGameId.success) throw new InvalidRacePlanError();
  const result = await client.execute({
    sql: "SELECT payload FROM race_plans WHERE game_id = ? ORDER BY updated_at DESC, id ASC",
    args: [parsedGameId.data],
  });
  return result.rows.map((row) => parsePlan(row.payload));
}

export async function createRacePlan(value: unknown): Promise<RacePlan> {
  const result = RacePlanInputSchema.safeParse(value);
  if (!result.success) throw new InvalidRacePlanError();
  return racePlanTransaction(async (tx) => {
    const now = new Date().toISOString();
    return persist(tx, randomUUID(), result.data, now, now);
  });
}

export async function updateRacePlan(id: string, value: unknown): Promise<RacePlan> {
  const result = RacePlanInputSchema.safeParse(value);
  if (!result.success) throw new InvalidRacePlanError();
  return racePlanTransaction(async (tx) => {
    const existing = await tx.execute({ sql: "SELECT created_at, game_id, car_id, track_id, payload FROM race_plans WHERE id = ?", args: [id] });
    if (!existing.rows.length) throw new RacePlanNotFoundError();
    const row = existing.rows[0];
    const previous = parsePlan(row.payload);
    if (row.game_id !== result.data.gameId || row.car_id !== result.data.carId || row.track_id !== result.data.trackId) {
      await tx.execute({ sql: "DELETE FROM active_race_plans WHERE plan_id = ?", args: [id] });
    }
    return persist(tx, id, result.data, String(row.created_at), new Date().toISOString(), previous);
  });
}

export async function deleteRacePlan(id: string): Promise<boolean> {
  return racePlanTransaction(async (tx) => {
    const existing = await tx.execute({ sql: "SELECT 1 FROM race_plans WHERE id = ?", args: [id] });
    if (!existing.rows.length) return false;
    await tx.execute({ sql: "DELETE FROM race_plans WHERE id = ?", args: [id] });
    await tx.execute({ sql: "DELETE FROM active_race_plans WHERE plan_id = ?", args: [id] });
    return true;
  });
}

export async function getActiveRacePlans(): Promise<RacePlan[]> {
  const result = await client.execute({
    sql: "SELECT p.payload FROM active_race_plans a JOIN race_plans p ON p.id = a.plan_id ORDER BY a.game_id, a.car_id, a.track_id",
  });
  return result.rows.map((row) => parsePlan(row.payload));
}

export async function setActiveRacePlan(input: SetActiveRacePlanInput): Promise<RacePlan | null> {
  return racePlanTransaction(async (tx) => {
    let plan: RacePlan | null = null;
    if (input.planId !== null) {
      const result = await tx.execute({ sql: "SELECT payload, game_id, car_id, track_id FROM race_plans WHERE id = ?", args: [input.planId] });
      if (!result.rows.length) throw new RacePlanNotFoundError();
      const row = result.rows[0];
      if (row.game_id !== input.gameId || row.car_id !== input.carId || row.track_id !== input.trackId) throw new InvalidRacePlanError();
      plan = parsePlan(row.payload);
    }
    if (input.planId === null) {
      await tx.execute({ sql: "DELETE FROM active_race_plans WHERE game_id = ? AND car_id = ? AND track_id = ?", args: [input.gameId, input.carId, input.trackId] });
      return null;
    }
    await tx.execute({
      sql: "INSERT INTO active_race_plans(game_id, car_id, track_id, plan_id) VALUES(?, ?, ?, ?) ON CONFLICT(game_id, car_id, track_id) DO UPDATE SET plan_id=excluded.plan_id",
      args: [input.gameId, input.carId, input.trackId, input.planId],
    });
    return plan;
  });
}
