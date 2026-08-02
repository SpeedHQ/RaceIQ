import { eq, and, sql } from "drizzle-orm";
import { db } from "./index";
import { lineSpreadCache } from "./schema";

const LINE_SPREAD_ALGO_VERSION = 1;


export function lineSpreadLapSetHash(lapIds: number[]): string {
  const sorted = [...lapIds].sort((a, b) => a - b);
  return `v${LINE_SPREAD_ALGO_VERSION}:${sorted.join(",")}`;
}

/** Read a cached line-spread trace JSON, or null on miss. */

export async function getLineSpreadCache(experimentId: number, lapSetHash: string): Promise<string | null> {
  const row = await db
    .select({ trace: lineSpreadCache.trace })
    .from(lineSpreadCache)
    .where(and(eq(lineSpreadCache.experimentId, experimentId), eq(lineSpreadCache.lapSetHash, lapSetHash)))
    .get();
  return row?.trace ?? null;
}

/** Store a computed line-spread trace JSON (upsert on the composite key). */

export async function setLineSpreadCache(experimentId: number, lapSetHash: string, trace: string): Promise<void> {
  await db
    .insert(lineSpreadCache)
    .values({ experimentId, lapSetHash, trace })
    .onConflictDoUpdate({
      target: [lineSpreadCache.experimentId, lineSpreadCache.lapSetHash],
      set: { trace, createdAt: sql`(datetime('now'))` },
    })
    .run();
}
