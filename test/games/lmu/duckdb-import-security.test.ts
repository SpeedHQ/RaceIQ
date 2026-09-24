import { expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewLMUDuckDB, readLMUDuckDBFrames } from "../../../server/games/lmu/import-duckdb";

test("LMU database views cannot read files outside the imported database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-import-security-"));
  const path = join(directory, "telemetry.duckdb");
  const sentinel = join(directory, "private.txt");
  writeFileSync(sentinel, "private-host-file");
  try {
    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();
    try {
      await connection.run(`CREATE VIEW metadata AS
        SELECT 'CarName' AS key, content AS value FROM read_text('${sentinel.replaceAll("'", "''")}')
        UNION ALL SELECT 'TrackName', 'Review Track'
        UNION ALL SELECT 'RecordingTime', '2026-09-22T00_00_00Z'`);
      await connection.run("CREATE TABLE channelsList AS SELECT 'Lap Dist' AS channelName, 10 AS frequency");
      await connection.run("CREATE TABLE eventsList(eventName VARCHAR)");
      await connection.run('CREATE TABLE "Lap Dist" AS SELECT range::FLOAT AS value FROM range(20)');
      await connection.run('CREATE TABLE "Lap" AS SELECT range AS value FROM range(2)');
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    await expect(previewLMUDuckDB(path)).rejects.toThrow(/disabled.*configuration|external access/i);
    await expect(readLMUDuckDBFrames(path).next()).rejects.toThrow(/disabled.*configuration|external access/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
