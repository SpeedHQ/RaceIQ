import { sql } from "drizzle-orm";
import { laps } from "./schema";

/** NULL is legacy evidence; known non-pace and non-finite lap times never enter pace rankings. */
export function paceLapCondition() {
  return sql`(${laps.lapTime} <= ${Number.MAX_VALUE} AND (${laps.classification} IS NULL OR ${laps.classification} = 'pace'))`;
}
