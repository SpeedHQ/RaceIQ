/**
 * Find all F1 2025 sessions created today and reprocess them via the
 * running server's /api/sessions/:id/reprocess endpoint. Fixes stale
 * rawByteOffset/rawFrameCount rows written before the session-reset fix.
 */
import { db } from "../server/db/index";
import { sessions } from "../server/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";

const SERVER = process.env.SERVER ?? "http://localhost:3117";
const since = new Date();
since.setHours(0, 0, 0, 0);
const sinceStr = since.toISOString().slice(0, 19).replace("T", " ");

const rows = await db
  .select({ id: sessions.id, createdAt: sessions.createdAt, rawFile: sessions.rawFile })
  .from(sessions)
  .where(and(eq(sessions.gameId, "f1-2025"), gte(sql`${sessions.createdAt}`, sinceStr)))
  .all();

console.log(`Found ${rows.length} F1 2025 session(s) since ${sinceStr}`);
for (const row of rows) {
  if (!row.rawFile) {
    console.log(`  session ${row.id}: no rawFile, skip`);
    continue;
  }
  try {
    const res = await fetch(`${SERVER}/api/sessions/${row.id}/reprocess`, { method: "POST" });
    const body = await res.json();
    console.log(`  session ${row.id}: ${res.status}`, body);
  } catch (err) {
    console.error(`  session ${row.id}: request failed`, err);
  }
}
process.exit(0);
