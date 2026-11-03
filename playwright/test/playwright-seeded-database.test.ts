import { afterEach, describe, expect, test } from "bun:test";
import Database from "libsql";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { iterateSessionCaptureRecordsFromSource, resolveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { DEFAULT_GAMES } from "@raceiq/tooling-data/data/seed-db-options";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords } from "../../packages/capture-formats/src/session/framing";
import { partitionLMUSourceFrame } from "../../packages/capture-formats/src/lmu/partition";
import { normalizeSeededCapturePaths, portableCapturePath, restoreSeededDatabase } from "../support/server/seeded-database";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await removeProducer(directory);
  }
}, 60_000);

async function releaseNativeHandles(): Promise<void> {
  // Native libsql finalizers need a real event-loop turn after their stack returns.
  // Fake timers cannot release these Windows OS file handles.
  if (process.platform === "win32") { Bun.gc(true); await Bun.sleep(0); }
}

async function removeProducer(directory: string): Promise<void> {
  await releaseNativeHandles();
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) throw error;
      // Native Windows handle release runs outside fake clocks; retry only OS-reported contention.
      await releaseNativeHandles();
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
}
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pw-seed-path-"));
  directories.push(directory);
  return directory;
}
function writeAsset(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function createSeed() {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "app.db");
  const database = new Database(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id INTEGER PRIMARY KEY, game_id TEXT NOT NULL, raw_file TEXT, capture_manifest_file TEXT, capture_archive_file TEXT);
      CREATE TABLE laps (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), raw_frame_count INTEGER NOT NULL);
    `);
    for (const [index, game] of DEFAULT_GAMES.entries()) {
      const rawFile = join(directory, "sessions", game, "own", "capture.bin");
      writeAsset(rawFile, Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame(), encodeFrameLength(4), Buffer.from([1, 2, 3, 4])]));
      database.prepare("INSERT INTO sessions VALUES (?, ?, ?, NULL, NULL)").run(index + 1, game, rawFile);
      database.prepare("INSERT INTO laps VALUES (?, ?, 1)").run(index + 1, index + 1);
    }
  } finally { database.close(); }
  const chat = new Database(join(directory, "chat-memory.db"));
  try {
    chat.exec("CREATE TABLE messages (text TEXT NOT NULL); INSERT INTO messages VALUES ('seeded chat history');");
  } finally { chat.close(); }
  return { directory, databasePath };
}
function withDatabase<T>(path: string, callback: (database: InstanceType<typeof Database>) => T): T {
  const database = new Database(path);
  try { return callback(database); } finally { database.close(); }
}
function readRow(path: string, sql: string): Record<string, unknown> {
  return withDatabase(path, (database) => {
    const row = database.prepare(sql).get() as Record<string, unknown>;
    // Strip libsql's native row metadata, preserving every selected SQL column.
    return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "_metadata"));
  });
}
function createDirectSeed() {
  const seed = createSeed();
  const directory = join(seed.directory, "sessions", "lmu", "own", "session-id");
  const manifestPath = join(directory, "capture-manifest.json");
  const native = [...iterateSessionCaptureRecords(gunzipSync(makeLmuOpponentCapture()), 0, { strict: true })]
    .find((record) => record.kind === "frame");
  if (!native || native.kind !== "frame") throw new Error("LMU fixture has no native frame");
  const partition = partitionLMUSourceFrame(native.frame);
  if (!partition?.companion) throw new Error("LMU fixture has no opponent companion");
  const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
  const primary = Buffer.concat([header, encodeFrameLength(partition.primary.length, native.frameTimeMs), partition.primary]);
  const companion = Buffer.concat([header, encodeFrameLength(partition.companion.length, native.frameTimeMs), partition.companion]);
  const sourceByteLength = 12 + encodeFrameLength(native.frame.length, native.frameTimeMs).length + native.frame.length;
  const manifest = {
    version: 3, gameId: "lmu", sourceRevision: "seed-fixture", sourceByteLength, sourceRecordCount: 1,
    sourceCoordinates: "native-wire-v1", opponentRetention: "retained",
    opponentCompanion: {
      file: "opponents.bin", codecVersion: 1, byteLength: companion.length,
      sha256: createHash("sha256").update(companion).digest("hex"), frameKeyStart: null, frameKeyEnd: null,
      committedPrefix: { byteLength: companion.length, recordCount: 1 },
    },
    chunks: [{
      id: "player-lap", kind: "lap", lapId: "7", lapNumber: 1, path: "player.bin", byteLength: primary.length,
      firstOrdinal: 0, recordCount: 1, sourceStart: 0, sourceEnd: 1, sourceByteStart: 12, sourceByteEnd: sourceByteLength,
      sourceRecordByteOffset: header.length, ownedFrameByteOffset: header.length, ownedFrameCount: 1,
    }],
  };
  writeAsset(manifestPath, JSON.stringify(manifest));
  writeAsset(join(directory, manifest.chunks[0].path), primary);
  writeAsset(join(directory, manifest.opponentCompanion.file), companion);
  withDatabase(seed.databasePath, (database) => {
    database.prepare("UPDATE sessions SET raw_file = ?, capture_manifest_file = ? WHERE game_id = 'lmu'").run(manifestPath, manifestPath);
  });
  return { ...seed, manifestPath, manifest, native, primary, companion };
}
function lmuReferences(databasePath: string) {
  return readRow(databasePath, "SELECT raw_file, capture_manifest_file, capture_archive_file FROM sessions WHERE game_id = 'lmu'") as {
    raw_file: string; capture_manifest_file: string; capture_archive_file: string | null;
  };
}

async function readFrames(rawFile: string, artifact?: Parameters<typeof iterateSessionCaptureRecordsFromSource>[0]["artifact"]) {
  const frames: Buffer[] = [];
  for await (const record of iterateSessionCaptureRecordsFromSource({
    rawFile, gameId: "lmu", carId: "fixture-player", trackId: "fixture-track", source: null, artifact,
  }, { strict: true })) if (record.kind === "frame") frames.push(record.frame);
  return frames;
}

describe("seeded database capture paths", () => {
  test.each([
    ["sessions\\lmu\\spa.bin.gz", "sessions/lmu/spa.bin.gz"],
    ["sessions\\lmu\\capture-manifest.json", "sessions/lmu/capture-manifest.json"],
    ["sessions\\lmu\\own\\session-id\\capture-manifest.json", "sessions/lmu/own/session-id/capture-manifest.json"],
    ["sessions\\fm-2023\\own\\capture.bin", "sessions/fm-2023/own/capture.bin"],
    ["sessions\\lmu\\others\\spa.bin.gz", "sessions/lmu/others/spa.bin.gz"],
    ["sessions\\iracing\\own\\navarra.ibt", "sessions/iracing/own/navarra.ibt"],
    ["sessions/iracing/others/navarra.ibt", "sessions/iracing/others/navarra.ibt"],
    ["sessions/lmu/own/session-7/attempt/manifest.json", "sessions/lmu/own/session-7/attempt/manifest.json"],
    ["sessions/lmu/own/session-7/attempt/capture.bin.gz", "sessions/lmu/own/session-7/attempt/capture.bin.gz"],
    ["sessions/lmu/own/capture.bin.gz.opponents-removed.capture-manifest.json", "sessions/lmu/own/capture.bin.gz.opponents-removed.capture-manifest.json"],
  ])("accepts organized capture %s", (input, expected) => {
    expect(portableCapturePath(input)).toBe(expected);
  });

  test("rejects LMU paths outside the capture directory and uncombined parts", () => {
    for (const path of [
      "sessions/lmu/../../app.db.bin.gz",
      "/sessions/lmu/spa.bin.gz",
      "sessions/lmu/spa.bin.gz.part1",
      "sessions/lmu/own/../../app.db.bin.gz",
      "sessions/lmu/unknown/spa.bin",
      "sessions/lmu/own/nested/spa.bin",
      "sessions/iracing/own/../../navarra.ibt",
      "sessions/iracing/own/nested/navarra.ibt",
      "sessions/acc/own/navarra.ibt",
    ]) {
      expect(() => portableCapturePath(path)).toThrow("Invalid seeded capture path");
    }
  });

  test("normalizes every session reference and restores companion-backed replay without producer files", async () => {
    const seed = createDirectSeed();
    withDatabase(seed.databasePath, (database) => normalizeSeededCapturePaths(database, seed.directory));
    const portableManifest = "sessions/lmu/own/session-id/capture-manifest.json";
    expect(lmuReferences(seed.databasePath)).toEqual({ raw_file: portableManifest, capture_manifest_file: portableManifest, capture_archive_file: null });
    const target = join(temporaryDirectory(), "runtime");
    restoreSeededDatabase(seed.directory, target, "app.db");
    await removeProducer(seed.directory);
    const restored = lmuReferences(join(target, "app.db"));
    expect(restored).toEqual({ raw_file: resolve(target, portableManifest), capture_manifest_file: resolve(target, portableManifest), capture_archive_file: null });
    expect(readFileSync(restored.capture_manifest_file, "utf8")).toBe(JSON.stringify(seed.manifest));
    expect(readFileSync(join(dirname(restored.capture_manifest_file), "player.bin"))).toEqual(seed.primary);
    expect(readFileSync(join(dirname(restored.capture_manifest_file), "opponents.bin"))).toEqual(seed.companion);
    expect(await readLmuOpponentRetention(restored.capture_manifest_file)).toMatchObject({ opponentRetention: "retained", opponentAvailability: "complete" });
    expect(await readFrames(restored.raw_file)).toEqual([seed.native.frame]);
    const lap = await resolveLapCaptureArtifact(restored.capture_manifest_file, "player-lap", 7, { captureLayoutVersion: 1 });
    expect(await readFrames(lap.path, lap.artifact)).toEqual([partitionLMUSourceFrame(seed.native.frame)!.primary]);
    expect(readRow(join(target, "chat-memory.db"), "SELECT text FROM messages")).toEqual({ text: "seeded chat history" });
  });

  test("rebases absolute producer references and copies archived replay members", async () => {
    const seed = createSeed();
    const directory = join(seed.directory, "sessions", "lmu", "own", "session-7", "attempt");
    const manifestPath = join(directory, "manifest.json");
    const archivePath = join(directory, "capture.bin.gz");
    const frame = Buffer.from([4, 3, 2, 1]);
    const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
    const chunk = Buffer.concat([header, encodeFrameLength(frame.length), frame]);
    const archive = gzipSync(chunk);
    const manifest = {
      version: 4, gameId: "lmu", sourceRevision: "archive-seed", sourceByteLength: chunk.length, sourceRecordCount: 1,
      archiveFile: "capture.bin.gz", chunks: [{
        id: "archived-lap", kind: "lap", lapId: "7", lapNumber: 1, entryName: "000001-lap-7.bin", memberOffset: 0,
        compressedByteLength: archive.length, byteLength: chunk.length, firstOrdinal: 0, recordCount: 1,
        sourceStart: 0, sourceEnd: 1, sourceByteStart: 12, sourceByteEnd: chunk.length,
        ownedFrameByteOffset: header.length, ownedFrameCount: 1,
      }],
    };
    writeAsset(manifestPath, JSON.stringify(manifest));
    writeAsset(archivePath, archive);
    withDatabase(seed.databasePath, (database) => {
      database.prepare("UPDATE sessions SET capture_manifest_file = ?, capture_archive_file = ? WHERE game_id = 'lmu'").run(manifestPath, archivePath);
      database.exec("CREATE TABLE live_captures (session_id INTEGER PRIMARY KEY REFERENCES sessions(id), source_path TEXT NOT NULL, archive_path TEXT NOT NULL, capture_epoch TEXT NOT NULL, status TEXT NOT NULL)");
      database.prepare("INSERT INTO live_captures SELECT id, raw_file, ?, 'preserved-epoch', 'sealed' FROM sessions WHERE game_id = 'lmu'").run(archivePath);
      normalizeSeededCapturePaths(database, seed.directory);
    });
    expect(lmuReferences(seed.databasePath).capture_archive_file).toBe("sessions/lmu/own/session-7/attempt/capture.bin.gz");
    expect(readRow(seed.databasePath, "SELECT source_path, archive_path FROM live_captures")).toEqual({
      source_path: "sessions/lmu/own/capture.bin", archive_path: "sessions/lmu/own/session-7/attempt/capture.bin.gz",
    });
    // Exercise restoration of absolute paths as well as portable artifact paths.
    withDatabase(seed.databasePath, (database) => database.prepare("UPDATE sessions SET raw_file = NULL, capture_manifest_file = ?, capture_archive_file = ? WHERE game_id = 'lmu'").run(manifestPath, archivePath));
    const target = temporaryDirectory();
    restoreSeededDatabase(seed.directory, target, "app.db");
    await removeProducer(seed.directory);
    const restored = lmuReferences(join(target, "app.db"));
    expect(restored.raw_file).toBeNull();
    expect(restored.capture_manifest_file).toBe(join(target, "sessions", "lmu", "own", "session-7", "attempt", "manifest.json"));
    expect(restored.capture_archive_file).toBe(join(dirname(restored.capture_manifest_file), "capture.bin.gz"));
    expect(readRow(join(target, "app.db"), "SELECT source_path, archive_path, capture_epoch, status FROM live_captures")).toEqual({
      source_path: join(target, "sessions", "lmu", "own", "capture.bin"), archive_path: restored.capture_archive_file,
      capture_epoch: "preserved-epoch", status: "sealed",
    });
    const lap = await resolveLapCaptureArtifact(restored.capture_manifest_file, "archived-lap", 7, {
      captureLayoutVersion: 2, captureArchiveFile: restored.capture_archive_file,
    });
    expect(await readFrames(lap.path, lap.artifact)).toEqual([frame]);
  });

  test("preserves removed companion state without fabricating deleted files", () => {
    const seed = createDirectSeed();
    seed.manifest.opponentRetention = "removed";
    const pending = "removed-opponents.bin";
    writeAsset(join(dirname(seed.manifestPath), pending), "pending removal");
    writeAsset(seed.manifestPath, JSON.stringify({ ...seed.manifest, cleanupPending: [pending, "already-deleted.bin"] }));
    rmSync(join(dirname(seed.manifestPath), seed.manifest.opponentCompanion.file));
    const target = temporaryDirectory();
    restoreSeededDatabase(seed.directory, target, "app.db");
    const restored = lmuReferences(join(target, "app.db"));
    expect(existsSync(join(dirname(restored.raw_file), "opponents.bin"))).toBe(false);
    expect(existsSync(join(dirname(restored.raw_file), "already-deleted.bin"))).toBe(false);
    expect(readFileSync(join(dirname(restored.raw_file), pending), "utf8")).toBe("pending removal");
    expect(JSON.parse(readFileSync(restored.raw_file, "utf8"))).toEqual({ ...seed.manifest, cleanupPending: [pending, "already-deleted.bin"] });
  });

  test.each(["player.bin", "opponents.bin"])("rejects missing required capture asset %s", (file) => {
    const seed = createDirectSeed();
    rmSync(join(dirname(seed.manifestPath), file));
    expect(() => restoreSeededDatabase(seed.directory, temporaryDirectory(), "app.db")).toThrow("Missing seeded capture asset");
  });

  test("rejects changed capture asset sizes", () => {
    const seed = createDirectSeed();
    writeAsset(join(dirname(seed.manifestPath), "player.bin"), seed.primary.subarray(0, -1));
    expect(() => restoreSeededDatabase(seed.directory, temporaryDirectory(), "app.db")).toThrow("Seeded capture asset byte length mismatch");
  });

  test("rejects destination junctions that escape runtime directory", () => {
    const seed = createDirectSeed();
    const target = temporaryDirectory();
    const outside = temporaryDirectory();
    symlinkSync(outside, join(target, "sessions"), process.platform === "win32" ? "junction" : "dir");
    expect(() => restoreSeededDatabase(seed.directory, target, "app.db")).toThrow("Capture outside seed directory");
    expect(existsSync(join(outside, "lmu", "own", "session-id", "capture-manifest.json"))).toBe(false);
  });

  test.each(["../outside.bin", "/outside.bin", "C:/outside.bin", "..\\outside.bin", "nested/../../outside.bin"])("rejects escaped manifest chunk %s", (path) => {
    const seed = createDirectSeed();
    seed.manifest.chunks[0]!.path = path;
    writeAsset(seed.manifestPath, JSON.stringify(seed.manifest));
    expect(() => restoreSeededDatabase(seed.directory, temporaryDirectory(), "app.db")).toThrow(/Invalid seeded manifest asset path|Capture outside seed directory/);
  });

  test("rejects escaped companions and pending cleanup references even when files are absent", () => {
    const seed = createDirectSeed();
    seed.manifest.opponentCompanion.file = "../outside.bin";
    writeAsset(seed.manifestPath, JSON.stringify(seed.manifest));
    expect(() => restoreSeededDatabase(seed.directory, temporaryDirectory(), "app.db")).toThrow("Invalid seeded opponent companion");
    seed.manifest.opponentCompanion.file = "opponents.bin";
    writeAsset(seed.manifestPath, JSON.stringify({ ...seed.manifest, cleanupPending: ["../outside.bin"] }));
    expect(() => restoreSeededDatabase(seed.directory, temporaryDirectory(), "app.db")).toThrow("Invalid seeded manifest asset path");
  });

  test("rejects symlink assets outside capture directory", () => {
    const seed = createDirectSeed();
    const outside = temporaryDirectory();
    writeAsset(join(outside, "player.bin"), seed.primary);
    // Directory junctions are available on Windows without file-symlink privileges.
    symlinkSync(outside, join(dirname(seed.manifestPath), "escaped"), process.platform === "win32" ? "junction" : "dir");
    seed.manifest.chunks[0]!.path = "escaped/player.bin";
    writeAsset(seed.manifestPath, JSON.stringify(seed.manifest));
    expect(() => restoreSeededDatabase(seed.directory, temporaryDirectory(), "app.db")).toThrow("Capture outside seed directory");
  });

  test("rejects absolute session references outside seed directory without rewriting database", () => {
    const seed = createSeed();
    const outside = join(temporaryDirectory(), "capture-manifest.json");
    withDatabase(seed.databasePath, (database) => {
      database.prepare("UPDATE sessions SET capture_manifest_file = ? WHERE game_id = 'lmu'").run(outside);
      expect(() => normalizeSeededCapturePaths(database, seed.directory)).toThrow("Capture outside seed directory");
    });
    expect(lmuReferences(seed.databasePath).capture_manifest_file).toBe(outside);
  });

  test.each([
    "sessions/lmu/../../app.db.bin.gz", "/sessions/lmu/spa.bin.gz", "sessions/lmu/spa.bin.gz.part1",
    "sessions/lmu/own/../../app.db.bin.gz", "sessions/lmu/unknown/spa.bin", "sessions/lmu/own/nested/spa.bin",
    "sessions/lmu/unknown/capture-manifest.json", "sessions/lmu/own/../capture-manifest.json", "sessions/lmu/own/C:/capture-manifest.json",
  ])("rejects invalid portable capture %s", (path) => {
    expect(() => portableCapturePath(path)).toThrow("Invalid seeded capture path");
  });
});
