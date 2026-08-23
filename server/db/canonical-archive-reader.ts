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

export interface CanonicalArchiveLapRange {
  startRow: number;
  endRow: number;
  participantId: string | null;
  lapNumber: number;
}

function sampleRow(row: Record<string, unknown>): CanonicalArchiveSampleRow {
  return {
    sampleOrdinal: Number(row.sample_ordinal),
    participantId: row.participant_id == null ? null : String(row.participant_id),
    lapId: row.lap_id == null ? null : Number(row.lap_id),
    lapNumber: row.lap_number == null ? null : Number(row.lap_number),
    sourceTimeMs: Number(row.source_time_ms),
    receivedAtMs: Number(row.received_at_ms),
    trackDistanceM: row.track_distance_m == null ? null : Number(row.track_distance_m),
    trackDistancePct: row.track_distance_pct == null ? null : Number(row.track_distance_pct),
    packetJson: String(row.packet_json),
  };
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
    return reader.getRowObjectsJS().map(sampleRow);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/**
 * Read several lap windows through one archive connection. Node ranges can span
 * interleaved participants, so each requested window also constrains durable
 * participant/lap identity from Parquet rather than trusting row bounds alone.
 */
export async function readCanonicalArchiveLapRanges(
  path: string,
  ranges: readonly CanonicalArchiveLapRange[],
): Promise<CanonicalArchiveSampleRow[][]> {
  const result = ranges.map(() => [] as CanonicalArchiveSampleRow[]);
  if (ranges.length === 0) return result;

  const requested = ranges.map((range, index) => {
    const start = Math.max(0, Math.trunc(range.startRow));
    const end = Math.max(start, Math.trunc(range.endRow));
    const participant = range.participantId == null ? "CAST(NULL AS VARCHAR)" : sqlString(range.participantId);
    const lapNumber = Math.trunc(range.lapNumber);
    return `(${index}, ${start}, ${end}, ${participant}, ${lapNumber})`;
  }).join(", ");

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      WITH requested(request_index, start_row, end_row, participant_id, lap_number) AS (VALUES ${requested})
      SELECT requested.request_index, telemetry_samples.sample_ordinal, telemetry_samples.participant_id,
        telemetry_samples.lap_id, telemetry_samples.lap_number, telemetry_samples.source_time_ms,
        telemetry_samples.received_at_ms, telemetry_samples.track_distance_m,
        telemetry_samples.track_distance_pct, telemetry_samples.packet_json
      FROM read_parquet(${sqlString(path)}) AS telemetry_samples
      INNER JOIN requested ON telemetry_samples.sample_ordinal >= requested.start_row
        AND telemetry_samples.sample_ordinal < requested.end_row
        AND telemetry_samples.participant_id IS NOT DISTINCT FROM requested.participant_id
        AND telemetry_samples.lap_number = requested.lap_number
      ORDER BY requested.request_index, telemetry_samples.sample_ordinal
    `);
    await reader.readAll();
    for (const row of reader.getRowObjectsJS()) {
      const index = Number(row.request_index);
      result[index]!.push(sampleRow(row));
    }
    return result;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
