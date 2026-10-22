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
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { client } from "@raceiq/backend-core/db/index";
import { withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";

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

async function resolveEvidence(tx: Transaction, input: RacePlanInput): Promise<RacePlanStint[]> {
  const output: RacePlanStint[] = [];
  for (const stint of input.stints) {
    if (stint.sourceSessionId === null || stint.sourceStintId === null) {
      output.push({ ...stint, compounds: [...stint.compounds], evidence: null });
      continue;
    }
    const result = await tx.execute({
      sql: `SELECT st.payload, st.driver_key, st.status, s.game_id, s.car_id, s.track_id, s.ownership
        FROM strategy_stints st JOIN sessions s ON s.id = st.session_id
        WHERE st.id = ? AND st.session_id = ? AND st.status IN ('completed','interrupted')`,
      args: [stint.sourceStintId, stint.sourceSessionId],
    });
    const row = result.rows[0];
    if (!row || row.ownership !== "mine") throw new RacePlanSourceNotFoundError();
    let evidence: StintSummary;
    try {
      evidence = StintSummarySchema.parse(JSON.parse(String(row.payload)));
    } catch {
      throw new InvalidRacePlanSourceError();
    }
    if (row.game_id !== input.gameId || row.car_id !== input.carId || row.track_id !== input.trackId ||
        evidence.gameId !== input.gameId || evidence.carId !== input.carId || evidence.trackId !== input.trackId ||
        evidence.sessionId !== stint.sourceSessionId || evidence.id !== stint.sourceStintId ||
        evidence.driverKey !== row.driver_key || evidence.status !== row.status ||
        evidence.status === "active" || evidence.endedAt === null || evidence.fuelUnit !== input.fuelUnit ||
        evidence.pi !== input.pi || (input.gameId === "fm-2023" && (input.pi === null || evidence.pi === null)) ||
        evidence.compounds.some((compound, index) => compound !== stint.compounds[index])) {
      throw new InvalidRacePlanSourceError();
    }
    output.push({ ...stint, compounds: [...stint.compounds], evidence });
  }
  return output;
}

async function persist(tx: Transaction, id: string, input: RacePlanInput, createdAt: string, updatedAt: string): Promise<RacePlan> {
  const stints = await resolveEvidence(tx, input);
  const plan = RacePlanSchema.parse({ ...input, id, createdAt, updatedAt, stints });
  await tx.execute({
    sql: `INSERT INTO race_plans(id, game_id, car_id, track_id, pi, created_at, updated_at, payload)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET game_id=excluded.game_id,car_id=excluded.car_id,
      track_id=excluded.track_id,pi=excluded.pi,updated_at=excluded.updated_at,payload=excluded.payload`,
    args: [id, plan.gameId, plan.carId, plan.trackId, plan.pi, createdAt, updatedAt, JSON.stringify(plan)],
  });
  return plan;
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
    const existing = await tx.execute({ sql: "SELECT created_at, game_id, car_id, track_id FROM race_plans WHERE id = ?", args: [id] });
    if (!existing.rows.length) throw new RacePlanNotFoundError();
    const row = existing.rows[0];
    if (row.game_id !== result.data.gameId || row.car_id !== result.data.carId || row.track_id !== result.data.trackId) {
      await tx.execute({ sql: "DELETE FROM active_race_plans WHERE plan_id = ?", args: [id] });
    }
    return persist(tx, id, result.data, String(row.created_at), new Date().toISOString());
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
