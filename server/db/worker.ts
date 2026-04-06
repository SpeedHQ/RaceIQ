/**
 * Background worker for expensive read-only DB queries.
 * Opens its own SQLite connection (WAL allows concurrent readers)
 * so heavy queries don't block the main event loop.
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, desc, and, or, isNull } from "drizzle-orm";
import * as schema from "./schema";
import type { GameId } from "../../shared/types";

const { sessions, laps, tunes } = schema;

// Receive DB path from the main thread
declare var self: Worker;

let db: ReturnType<typeof drizzle>;

self.onmessage = (event: MessageEvent) => {
  const { type, id, ...params } = event.data;

  if (type === "init") {
    const sqlite = new Database(params.dbPath, { readonly: true });
    sqlite.exec("PRAGMA journal_mode = WAL");
    db = drizzle(sqlite, { schema });
    self.postMessage({ id, result: "ok" });
    return;
  }

  if (type === "getLaps") {
    try {
      const result = queryGetLaps(params.profileId, params.gameId, params.limit);
      self.postMessage({ id, result });
    } catch (err: any) {
      self.postMessage({ id, error: err.message });
    }
    return;
  }

  self.postMessage({ id, error: `Unknown query type: ${type}` });
};

function queryGetLaps(profileId?: number | null, gameId?: GameId, limit: number = 200) {
  const query = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      pi: laps.pi,
      carSetup: laps.carSetup,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id))
    .limit(limit);

  const conditions = [];
  if (profileId != null) {
    conditions.push(or(eq(laps.profileId, profileId), isNull(laps.profileId)));
  }
  if (gameId) {
    conditions.push(eq(sessions.gameId, gameId));
  }

  const rows = conditions.length > 0
    ? query.where(and(...conditions)).all()
    : query.all();

  return rows.map((r) => ({
    ...r,
    isValid: Boolean(r.isValid),
    invalidReason: r.invalidReason ?? undefined,
    pi: r.pi ?? 0,
    carSetup: r.carSetup ?? undefined,
    tuneId: r.tuneId ?? undefined,
    tuneName: r.tuneName ?? undefined,
    gameId: r.gameId as GameId,
  }));
}
