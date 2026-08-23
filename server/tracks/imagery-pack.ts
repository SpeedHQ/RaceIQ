import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TRACK_IMAGERY_PACKAGE_NAME, TrackImageryGeographicBoundsSchema, type TrackImageryGeographicBounds } from "../../shared/racing/tracks/imagery";

export { TRACK_IMAGERY_PACKAGE_NAME };

export const TRACK_IMAGERY_PACK_SCHEMA_VERSION = 1 as const;
export const TRACK_IMAGERY_PACK_TIER = "hq" as const;
export const TRACK_IMAGERY_PACK_FORMAT = "webp" as const;

export interface TrackImageryPackMetadata {
  schemaVersion: typeof TRACK_IMAGERY_PACK_SCHEMA_VERSION;
  tier: typeof TRACK_IMAGERY_PACK_TIER;
  width: number;
  height: number;
  tileSize: number;
  columns: number;
  rows: number;
  resolutionM?: number;
  bounds: TrackImageryGeographicBounds;
  contentHash?: string;
}

export interface TrackImageryPackTile {
  tier: typeof TRACK_IMAGERY_PACK_TIER;
  x: number;
  y: number;
  width: number;
  height: number;
  format: typeof TRACK_IMAGERY_PACK_FORMAT;
  data: Uint8Array;
}

export type TrackImageryPackTileSource = Iterable<TrackImageryPackTile> | AsyncIterable<TrackImageryPackTile>;

export interface TrackImageryPackWriteOptions {
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

function assertPackWriteActive(options: TrackImageryPackWriteOptions): void {
  options.signal?.throwIfAborted();
  if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) throw new Error("Imagery import exceeded its job deadline");
}

const PACK_METADATA_KEYS = new Set(["schemaVersion", "tier", "width", "height", "tileSize", "columns", "rows", "resolutionM", "bounds", "contentHash"]);

function fail(path: string, message: string): never {
  throw new Error(`Invalid imagery pack ${path}: ${message}`);
}

function integer(value: unknown, name: string, path: string, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    fail(path, `${name} must be ${positive ? "a positive" : "a non-negative"} safe integer`);
  }
  return value;
}

function finitePositive(value: unknown, name: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(path, `${name} must be positive and finite`);
  return value;
}

function validateMetadata(input: TrackImageryPackMetadata, path: string): TrackImageryPackMetadata {
  if (input.schemaVersion !== TRACK_IMAGERY_PACK_SCHEMA_VERSION) fail(path, "unsupported schemaVersion");
  if (input.tier !== TRACK_IMAGERY_PACK_TIER) fail(path, "only hq tier is supported");
  const width = integer(input.width, "width", path, true);
  const height = integer(input.height, "height", path, true);
  const tileSize = integer(input.tileSize, "tileSize", path, true);
  const columns = integer(input.columns, "columns", path, true);
  const rows = integer(input.rows, "rows", path, true);
  if (columns !== Math.ceil(width / tileSize) || rows !== Math.ceil(height / tileSize)) fail(path, "columns/rows do not describe complete tile grid");
  if (input.resolutionM !== undefined) finitePositive(input.resolutionM, "resolutionM", path);
  const parsedBounds = TrackImageryGeographicBoundsSchema.safeParse(input.bounds);
  if (!parsedBounds.success) fail(path, `bounds are invalid: ${parsedBounds.error.message}`);
  if (input.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(input.contentHash)) fail(path, "contentHash must be lowercase SHA-256");
  return { ...input, width, height, tileSize, columns, rows };
}

function metadataRows(metadata: TrackImageryPackMetadata): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["schemaVersion", String(metadata.schemaVersion)],
    ["tier", metadata.tier],
    ["width", String(metadata.width)],
    ["height", String(metadata.height)],
    ["tileSize", String(metadata.tileSize)],
    ["columns", String(metadata.columns)],
    ["rows", String(metadata.rows)],
  ];
  if (metadata.resolutionM !== undefined) rows.push(["resolutionM", String(metadata.resolutionM)]);
  rows.push(["bounds", JSON.stringify(metadata.bounds)]);
  if (metadata.contentHash !== undefined) rows.push(["contentHash", metadata.contentHash]);
  return rows;
}

function parseInteger(path: string, key: string, value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail(path, `metadata ${key} must be canonical integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(path, `metadata ${key} exceeds safe integer range`);
  return parsed;
}

function validateSchema(db: Database, path: string): void {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  const names = tables.map((row) => row.name).sort();
  if (names.length !== 2 || names[0] !== "metadata" || names[1] !== "tiles") fail(path, "unexpected SQLite tables");
  const metadataColumns = db.query("PRAGMA table_info(metadata)").all() as Array<{ name: string; notnull: number; pk: number }>;
  const tileColumns = db.query("PRAGMA table_info(tiles)").all() as Array<{ name: string; notnull: number; pk: number }>;
  const expectedMetadata = ["key", "value"];
  const expectedTiles = ["tier", "x", "y", "width", "height", "format", "data"];
  if (metadataColumns.map((column) => column.name).join(",") !== expectedMetadata.join(",")) fail(path, "metadata table schema mismatch");
  if (tileColumns.map((column) => column.name).join(",") !== expectedTiles.join(",")) fail(path, "tiles table schema mismatch");
  if (metadataColumns.some((column) => column.name === "value" && column.notnull !== 1) || tileColumns.some((column) => column.notnull !== 1)) fail(path, "pack columns must be NOT NULL");
  if (
    metadataColumns
      .filter((column) => column.pk > 0)
      .map((column) => column.name)
      .join(",") !== "key"
  )
    fail(path, "metadata primary key mismatch");
  const primaryKey = tileColumns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  if (primaryKey.join(",") !== "tier,x,y") fail(path, "tiles primary key mismatch");
}

function parseMetadataRows(path: string, rows: Array<{ key: string; value: string }>): TrackImageryPackMetadata {
  const values = new Map<string, string>();
  for (const row of rows) {
    if (values.has(row.key) || !PACK_METADATA_KEYS.has(row.key)) fail(path, `unexpected or duplicate metadata key ${row.key}`);
    values.set(row.key, row.value);
  }
  const required = ["schemaVersion", "tier", "width", "height", "tileSize", "columns", "rows", "bounds", "contentHash"];
  for (const key of required) if (!values.has(key)) fail(path, `missing metadata ${key}`);
  let rawBounds: unknown;
  try {
    rawBounds = JSON.parse(values.get("bounds")!);
  } catch {
    fail(path, "bounds metadata is not valid JSON");
  }
  const parsedBounds = TrackImageryGeographicBoundsSchema.safeParse(rawBounds);
  if (!parsedBounds.success) fail(path, `bounds metadata is invalid: ${parsedBounds.error.message}`);
  const hash = values.get("contentHash")!;
  if (!/^[a-f0-9]{64}$/.test(hash)) fail(path, "contentHash must be lowercase SHA-256");
  const metadata: TrackImageryPackMetadata = {
    schemaVersion: parseInteger(path, "schemaVersion", values.get("schemaVersion")!) as 1,
    tier: values.get("tier") as "hq",
    width: parseInteger(path, "width", values.get("width")!),
    height: parseInteger(path, "height", values.get("height")!),
    tileSize: parseInteger(path, "tileSize", values.get("tileSize")!),
    columns: parseInteger(path, "columns", values.get("columns")!),
    rows: parseInteger(path, "rows", values.get("rows")!),
    bounds: parsedBounds.data,
    contentHash: hash,
  };
  if (values.has("resolutionM")) metadata.resolutionM = finitePositive(Number(values.get("resolutionM")), "resolutionM", path);
  return validateMetadata(metadata, path);
}

function assertTile(tile: TrackImageryPackTile, metadata: TrackImageryPackMetadata, path: string): void {
  if (tile.tier !== "hq" || !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)) fail(path, "tile tier or coordinates invalid");
  if (tile.x < 0 || tile.x >= metadata.columns || tile.y < 0 || tile.y >= metadata.rows) fail(path, `tile coordinate out of range (${tile.x},${tile.y})`);
  const expectedWidth = Math.min(metadata.tileSize, metadata.width - tile.x * metadata.tileSize);
  const expectedHeight = Math.min(metadata.tileSize, metadata.height - tile.y * metadata.tileSize);
  if (tile.width !== expectedWidth || tile.height !== expectedHeight) fail(path, `tile dimensions invalid at (${tile.x},${tile.y})`);
  if (tile.format !== "webp") fail(path, "tile format must be webp");
  if (!(tile.data instanceof Uint8Array) || tile.data.byteLength === 0) fail(path, `tile data missing at (${tile.x},${tile.y})`);
}

function validateTileGrid(db: Database, metadata: TrackImageryPackMetadata, path: string, options: TrackImageryPackWriteOptions): void {
  const rows = db.query("SELECT tier,x,y,width,height,format,length(data) AS dataLength FROM tiles").all() as Array<Omit<TrackImageryPackTile, "data"> & { dataLength: number }>;
  if (rows.length !== metadata.columns * metadata.rows) fail(path, `expected ${metadata.columns * metadata.rows} tiles, received ${rows.length}`);
  const seen = new Set<string>();
  for (const row of rows) {
    assertPackWriteActive(options);
    if (!Number.isSafeInteger(row.dataLength) || row.dataLength <= 0) fail(path, `tile data missing at (${row.x},${row.y})`);
    const tile = { ...row, data: new Uint8Array([1]) };
    assertTile(tile, metadata, path);
    const key = `${row.x}:${row.y}`;
    if (seen.has(key)) fail(path, `duplicate tile at (${row.x},${row.y})`);
    seen.add(key);
  }
}

function canonicalMetadata(metadata: TrackImageryPackMetadata): string {
  return JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    tier: metadata.tier,
    width: metadata.width,
    height: metadata.height,
    tileSize: metadata.tileSize,
    columns: metadata.columns,
    rows: metadata.rows,
    resolutionM: metadata.resolutionM ?? null,
    bounds: metadata.bounds,
  });
}

function tileDigest(tile: TrackImageryPackTile): string {
  return createHash("sha256").update(`${tile.x},${tile.y},${tile.width},${tile.height},${tile.format}\0`).update(tile.data).digest("hex");
}

function replacePack(tempPath: string, targetPath: string): void {
  try {
    renameSync(tempPath, targetPath);
    return;
  } catch {
    const backupPath = `${targetPath}.${randomUUID()}.bak`;
    let movedExisting = false;
    try {
      try {
        renameSync(targetPath, backupPath);
        movedExisting = true;
      } catch {}
      renameSync(tempPath, targetPath);
      if (movedExisting) rmSync(backupPath, { force: true });
    } catch (error) {
      if (movedExisting) {
        rmSync(targetPath, { force: true });
        renameSync(backupPath, targetPath);
      }
      throw error;
    }
  }
}

export async function writeTrackImageryPack(
  targetPath: string,
  input: TrackImageryPackMetadata,
  tiles: TrackImageryPackTileSource,
  options: TrackImageryPackWriteOptions = {},
): Promise<TrackImageryPackMetadata> {
  assertPackWriteActive(options);
  const target = resolve(targetPath);
  const metadata = validateMetadata(input, target);
  const tempPath = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(tempPath, { force: true });
  let db: Database | undefined;
  try {
    db = new Database(tempPath, { create: true, strict: true });
    db.exec(
      "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE tiles (tier TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, format TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(tier,x,y)) WITHOUT ROWID;",
    );
    const insertMetadata = db.query("INSERT INTO metadata (key,value) VALUES (?,?)");
    for (const [key, value] of metadataRows(metadata)) insertMetadata.run(key, value);
    db.exec("BEGIN IMMEDIATE");
    const insertTile = db.query("INSERT INTO tiles (tier,x,y,width,height,format,data) VALUES (?,?,?,?,?,?,?)");
    const digests = new Map<string, string>();
    let count = 0;
    for await (const tile of tiles) {
      assertPackWriteActive(options);
      assertTile(tile, metadata, target);
      const key = `${tile.x}:${tile.y}`;
      if (digests.has(key)) fail(target, `duplicate tile at (${tile.x},${tile.y})`);
      digests.set(key, tileDigest(tile));
      insertTile.run(tile.tier, tile.x, tile.y, tile.width, tile.height, tile.format, tile.data);
      count++;
    }
    assertPackWriteActive(options);
    if (count !== metadata.columns * metadata.rows) fail(target, `expected ${metadata.columns * metadata.rows} tiles, received ${count}`);
    db.exec("COMMIT");
    const contentHash = createHash("sha256").update(canonicalMetadata(metadata));
    for (const [key, digest] of [...digests.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      assertPackWriteActive(options);
      contentHash.update(`${key}:${digest};`);
    }
    const completed = { ...metadata, contentHash: contentHash.digest("hex") };
    db.query("INSERT OR REPLACE INTO metadata (key,value) VALUES (?,?)").run("contentHash", completed.contentHash);
    assertPackWriteActive(options);
    validateSchema(db, target);
    const completedRows = db.query("SELECT key,value FROM metadata ORDER BY key").all() as Array<{ key: string; value: string }>;
    validateTileGrid(db, parseMetadataRows(target, completedRows), target, options);
    assertPackWriteActive(options);
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (integrity?.integrity_check !== "ok") fail(target, "SQLite integrity check failed");
    assertPackWriteActive(options);
    db.close();
    db = undefined;
    replacePack(tempPath, target);
    return completed;
  } catch (error) {
    try {
      if (db) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        db.close();
      }
    } finally {
      rmSync(tempPath, { force: true });
    }
    throw error;
  }
}

export function readTrackImageryPackMetadata(packPath: string): TrackImageryPackMetadata {
  const path = resolve(packPath);
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false, strict: true });
    validateSchema(db, path);
    const rows = db.query("SELECT key,value FROM metadata ORDER BY key").all() as Array<{ key: string; value: string }>;
    return parseMetadataRows(path, rows);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid imagery pack")) throw error;
    return fail(path, error instanceof Error ? error.message : "unable to open package");
  } finally {
    db?.close();
  }
}

export function readTrackImageryPackTile(packPath: string, x: number, y: number, metadata?: TrackImageryPackMetadata): TrackImageryPackTile | null {
  const path = resolve(packPath);
  const checkedMetadata = metadata ?? readTrackImageryPackMetadata(path);
  validateMetadata(checkedMetadata, path);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= checkedMetadata.columns || y >= checkedMetadata.rows) return null;
  const db = new Database(path, { readonly: true, create: false, strict: true });
  try {
    const row = db.query("SELECT tier,x,y,width,height,format,data FROM tiles WHERE tier = 'hq' AND x = ? AND y = ?").get(x, y) as (Omit<TrackImageryPackTile, "data"> & { data: Uint8Array }) | null;
    if (!row) return null;
    const tile = { ...row, data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as unknown as ArrayBuffer) };
    assertTile(tile, checkedMetadata, path);
    return tile;
  } finally {
    db.close();
  }
}
