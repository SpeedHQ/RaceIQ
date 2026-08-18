import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readTrackImageryPackMetadata, readTrackImageryPackTile, writeTrackImageryPack, type TrackImageryPackTile } from "../server/tracks/imagery-pack";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tile(x: number, y: number, width: number, height: number): TrackImageryPackTile {
  return { tier: "hq", x, y, width, height, format: "webp", data: Uint8Array.from([x, y, width, height]) };
}

test("writes strict HQ SQLite package metadata and partial edge rows", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".imagery-pack-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "imagery.rqi");
  const metadata = {
    schemaVersion: 1 as const,
    tier: "hq" as const,
    width: 1_025,
    height: 513,
    tileSize: 512,
    columns: 3,
    rows: 2,
    resolutionM: 0.1,
    bounds: { west: -81.01, south: 28.99, east: -80.99, north: 29.01 },
  };
  const tiles = [tile(0, 0, 512, 512), tile(1, 0, 512, 512), tile(2, 0, 1, 512), tile(0, 1, 512, 1), tile(1, 1, 512, 1), tile(2, 1, 1, 1)];
  await writeTrackImageryPack(path, metadata, tiles);

  const database = new Database(path, { readonly: true });
  expect(database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tiles'").get()).toMatchObject({
    sql: expect.stringContaining("PRIMARY KEY(tier,x,y)"),
  });
  expect(readTrackImageryPackMetadata(path)).toMatchObject(metadata);
  expect(readTrackImageryPackMetadata(path).contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(database.query("SELECT width,height FROM tiles WHERE tier = 'hq' AND x = 2 AND y = 1").get()).toEqual({ width: 1, height: 1 });
  expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "metadata" }, { name: "tiles" }]);
  database.close();

  expect(readTrackImageryPackTile(path, 2, 1)).toMatchObject({ tier: "hq", x: 2, y: 1, width: 1, height: 1, format: "webp" });
  expect(Array.from(readTrackImageryPackTile(path, 2, 1)!.data)).toEqual([2, 1, 1, 1]);
  expect(readTrackImageryPackTile(path, 3, 0)).toBeNull();
  const malformed = new Database(path);
  malformed.query("INSERT INTO metadata (key,value) VALUES ('unexpected','1')").run();
  malformed.close();
  expect(() => readTrackImageryPackMetadata(path)).toThrow(/unexpected|Invalid imagery pack/);
});

test("accepts async tile producers and rejects duplicate HQ composite keys without replacing existing package", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".imagery-pack-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "imagery.rqi");
  const metadata = {
    schemaVersion: 1 as const,
    tier: "hq" as const,
    width: 512,
    height: 512,
    tileSize: 512,
    columns: 1,
    rows: 1,
    resolutionM: 0.1,
    bounds: { west: -81.01, south: 28.99, east: -80.99, north: 29.01 },
  };
  await writeTrackImageryPack(path, metadata, [tile(0, 0, 512, 512)]);
  const before = readTrackImageryPackMetadata(path);
  async function* tiles(): AsyncIterable<TrackImageryPackTile> {
    yield tile(0, 0, 512, 512);
    yield tile(0, 0, 512, 512);
  }
  await expect(writeTrackImageryPack(path, metadata, tiles())).rejects.toThrow();
  expect(readTrackImageryPackMetadata(path)).toEqual(before);
});
