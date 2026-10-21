import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

export async function populateLMUDuckDB(
  connection: DuckDBConnection,
  lapRows = "(0,0),(15,1),(30,2)",
  includeLapDistance = true,
): Promise<void> {
  await connection.run("CREATE TABLE metadata(key VARCHAR, value VARCHAR)");
  await connection.run(`INSERT INTO metadata VALUES
    ('Version','1'),
    ('RecordingTime','2026-08-12T18_01_09Z'),
    ('SessionType','Race'),
    ('DriverName','Test Driver'),
    ('CarName','Ferrari 499P #50'),
    ('CarClass','Hypercar'),
    ('TrackName','Circuit de la Sarthe')`);
  await connection.run("CREATE TABLE channelsList(channelName VARCHAR, frequency INTEGER, unit VARCHAR)");
  await connection.run(
    `INSERT INTO channelsList VALUES ${
      includeLapDistance ? "('Lap Dist',10,'m')," : ""
    }('Ground Speed',50,'km/h'),('Susp Pos',50,'mm')`,
  );
  await connection.run("CREATE TABLE eventsList(eventName VARCHAR, unit VARCHAR)");
  if (includeLapDistance) {
    await connection.run('CREATE TABLE "Lap Dist" AS SELECT ((range % 150) * (1000.0 / 150))::FLOAT AS value FROM range(300)');
  }
  await connection.run('CREATE TABLE "Ground Speed" AS SELECT 180::FLOAT AS value FROM range(1501)');
  await connection.run('CREATE TABLE "Susp Pos" AS SELECT 50::FLOAT AS value1, 50::FLOAT AS value2, 50::FLOAT AS value3, 50::FLOAT AS value4 FROM range(1501)');
  await connection.run('CREATE TABLE "Lap"(ts DOUBLE, value USMALLINT)');
  await connection.run(`INSERT INTO "Lap" VALUES ${lapRows}`);
  await connection.run('CREATE TABLE "Lap Time"(ts DOUBLE, value FLOAT)');
  await connection.run('INSERT INTO "Lap Time" VALUES (0,0),(15,15),(30,15)');
  await connection.run('CREATE TABLE "Best LapTime"(ts DOUBLE, value FLOAT)');
  await connection.run('INSERT INTO "Best LapTime" VALUES (0,0),(15,15)');
  await connection.run('CREATE TABLE "Engine Max RPM"(ts DOUBLE, value FLOAT)');
  await connection.run('INSERT INTO "Engine Max RPM" VALUES (0,11000)');
}

export async function createLMUDuckDB(
  path: string,
  lapRows?: string,
  includeLapDistance = true,
): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  try {
    await populateLMUDuckDB(connection, lapRows, includeLapDistance);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
