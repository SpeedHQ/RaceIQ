import { DuckDBInstance } from "@duckdb/node-api";

export interface CanonicalArchiveSampleRow {
  sampleOrdinal: number;
  participantId: string | null;
  lapId: number | null;
  lapNumber: number | null;
  sourceTimeMs: number;
  receivedAtMs: number;
  trackDistanceM: number | null;
  trackDistancePct: number | null;
  packetJson: string;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function readCanonicalArchiveSamples(path: string, startRow = 0, endRow?: number): Promise<CanonicalArchiveSampleRow[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = sqlString(path);
    const start = Math.max(0, Math.trunc(startRow));
    const end = endRow == null ? "NULL" : String(Math.max(start, Math.trunc(endRow)));
    const reader = await connection.runAndReadAll(`SELECT sample_ordinal, participant_id, lap_id, lap_number, source_time_ms, received_at_ms, track_distance_m, track_distance_pct, packet_json FROM read_parquet(${file}) WHERE sample_ordinal >= ${start} AND (${end} IS NULL OR sample_ordinal < ${end}) ORDER BY sample_ordinal`);
    await reader.readAll();
    return reader.getRowObjectsJS().map((row) => ({
      sampleOrdinal: Number(row.sample_ordinal),
      participantId: row.participant_id == null ? null : String(row.participant_id),
      lapId: row.lap_id == null ? null : Number(row.lap_id),
      lapNumber: row.lap_number == null ? null : Number(row.lap_number),
      sourceTimeMs: Number(row.source_time_ms),
      receivedAtMs: Number(row.received_at_ms),
      trackDistanceM: row.track_distance_m == null ? null : Number(row.track_distance_m),
      trackDistancePct: row.track_distance_pct == null ? null : Number(row.track_distance_pct),
      packetJson: String(row.packet_json),
    }));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
