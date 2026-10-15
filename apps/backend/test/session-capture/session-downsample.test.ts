import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { previewSessionDownsample } from "@raceiq/backend-core/session-capture/session-downsample";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { ACC_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import type { GameId } from "@raceiq/shared/games/ids";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
const oldDate = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const sessionIds: number[] = [];
const lapIds: number[] = [];
const tempDirs: string[] = [];

initGameAdapters();
initServerGameAdapters();
function ownedPath(name: string): string {
  const dir = resolve(join(resolveRecordingDirectory(), `downsample-preview-${crypto.randomUUID()}`));
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return join(dir, name);
}

async function writeSparseFixture(path: string, gameId: GameId): Promise<void> {
  const fixture = gameId === "fm-2023"
    ? "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"
    : "test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz";
  const recorder = new SparseSessionRecorder(gameId);
  recorder.start(path);
  recorder.writeMetaFrame();
  if (gameId === "acc") {
    const frames = readKunosFrames(fixture).slice(0, 520).map(({ physics, graphics, staticData }) =>
      packTriplet(ACC_PACKED_MAGIC, 1, 1, physics, graphics, staticData));
    for (const frame of frames) recorder.writeRecord(frame);
  } else {
    const data = gunzipSync(readFileSync(fixture));
    let count = 0;
    for (const frame of iterateSessionFrames(data)) {
      recorder.writeRecord(frame);
      if (++count === 520) break;
    }
  }
  await recorder.stop();
}

async function addSession(options: {
  path: string | null;
  createdAt?: string;
  gameId?: string;
  source?: string | null;
  favorite?: boolean;
  cap?: number | null;
}): Promise<number> {
  const { id } = await db.insert(sessions).values({
    gameId: options.gameId ?? "fm-2023",
    carId: "1",
    trackId: "1",
    rawFile: options.path,
    source: options.source ?? null,
    createdAt: options.createdAt ?? oldDate(100),
    isFavorite: options.favorite ?? false,
    downsampledFrequencyHz: options.cap ?? null,
  }).returning({ id: sessions.id }).get();
  sessionIds.push(id);
  return id;
}

async function addLap(sessionId: number, favorite = false): Promise<void> {
  const { id } = await db.insert(laps).values({ sessionId, lapNumber: 1, lapTime: 90, isValid: true, isFavorite: favorite })
    .returning({ id: laps.id }).get();
  lapIds.push(id);
}

afterEach(async () => {
  if (lapIds.length) await db.delete(laps).where(inArray(laps.id, lapIds.splice(0))).run();
  if (sessionIds.length) await db.delete(sessions).where(inArray(sessions.id, sessionIds.splice(0))).run();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session downsample preview", () => {
  test("returns eligible canonical file bytes and leaves file and DB metadata unchanged", async () => {
    const path = ownedPath("canonical.bin");
    await writeSparseFixture(path, "fm-2023");
    const id = await addSession({ path });
    await addLap(id);
    const beforeBytes = readFileSync(path);
    const before = await db.select({
      rawFile: sessions.rawFile,
      cap: sessions.downsampledFrequencyHz,
      lapId: laps.id,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
    }).from(sessions).leftJoin(laps, eq(laps.sessionId, sessions.id)).where(inArray(sessions.id, [id])).get();

    const preview = await previewSessionDownsample({ mode: "all", targetHz: 50 });

    expect(preview.candidateSessionIds).toContain(id);
    expect(preview.fileCount).toBeGreaterThan(0);
    expect(preview.sourceBytes).toBeGreaterThanOrEqual(statSync(path).size);
    expect(readFileSync(path)).toEqual(beforeBytes);
    expect(await db.select({
      rawFile: sessions.rawFile,
      cap: sessions.downsampledFrequencyHz,
      lapId: laps.id,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
    }).from(sessions).leftJoin(laps, eq(laps.sessionId, sessions.id)).where(inArray(sessions.id, [id])).get()).toEqual(before);
  });

  test("shared references age-conflict and favorites protect whole file; cap applies only when all refs capped", async () => {
    const shared = ownedPath("shared.bin");
    await writeSparseFixture(shared, "fm-2023");
    const old = await addSession({ path: shared });
    const recent = await addSession({ path: shared, createdAt: oldDate(2) });
    const favoriteLapPath = ownedPath("favorite-lap.bin");
    copyFileSync(shared, favoriteLapPath);
    const normal = await addSession({ path: favoriteLapPath });
    const favoriteLapSession = await addSession({ path: favoriteLapPath });
    await addLap(favoriteLapSession, true);
    const favoritePath = ownedPath("favorite-session.bin");
    copyFileSync(shared, favoritePath);
    const favorite = await addSession({ path: favoritePath, favorite: true });
    const capped = ownedPath("capped.bin");
    copyFileSync(shared, capped);
    const cappedA = await addSession({ path: capped, cap: 50 });
    const cappedB = await addSession({ path: capped, cap: 50 });
    const partialCap = ownedPath("partial-cap.bin");
    copyFileSync(shared, partialCap);
    const partialA = await addSession({ path: partialCap, cap: 50 });
    const partialB = await addSession({ path: partialCap });
    const recentOnly = ownedPath("recent-only.bin");
    copyFileSync(shared, recentOnly);
    const recentOnlyId = await addSession({ path: recentOnly, createdAt: oldDate(2) });
    const ownIds = new Set(sessionIds);

    const preview = await previewSessionDownsample({ mode: "older-than", olderThanDays: 30, targetHz: 50 });

    expect(preview.candidateSessionIds.filter((id) => ownIds.has(id))).toEqual([partialA, partialB]);
    expect(preview.candidateSessionIds.filter((id) => ownIds.has(id))).not.toContain(recentOnlyId);
    const ownSkipped = preview.skipped.filter((item) => item.sessionIds.some((id) => ownIds.has(id)));
    expect(ownSkipped.flatMap((item) => item.sessionIds)).not.toContain(recentOnlyId);
    expect(ownSkipped).toEqual(expect.arrayContaining([
      { sessionIds: [old, recent], reason: "shared-age-conflict" },
      { sessionIds: [normal, favoriteLapSession], reason: "favorite" },
      { sessionIds: [favorite], reason: "favorite" },
      { sessionIds: [cappedA, cappedB], reason: "already-at-or-below-target" },
    ]));
  });

  test("reports missing, unowned, MoTeC, legacy, and unreliable files without mutating references", async () => {
    const noFileId = await addSession({ path: null });
    const missing = ownedPath("missing.bin");
    const missingId = await addSession({ path: missing });
    const outsideDir = mkdtempSync(join(tmpdir(), "downsample-unowned-"));
    const outside = join(outsideDir, "outside.bin");
    tempDirs.push(outsideDir);
    writeFileSync(outside, Buffer.from("not owned"));
    const unownedId = await addSession({ path: outside });
    const motec = ownedPath("source-motec.bin");
    writeFileSync(motec, Buffer.from("motec bytes"));
    const motecId = await addSession({ path: motec, source: "motec" });
    const legacy = ownedPath("legacy.bin");
    writeFileSync(legacy, Buffer.from("legacy non-canonical recording"));
    const legacyId = await addSession({ path: legacy });
    const malformed = ownedPath("malformed.bin");
    writeFileSync(malformed, Buffer.from("malformed capture"));
    const malformedId = await addSession({ path: malformed });
    const nativePath = ownedPath("native-unreliable.bin");
    await writeSparseFixture(nativePath, "acc");
    const nativeId = await addSession({ path: nativePath, gameId: "acc" });

    const preview = await previewSessionDownsample({ mode: "all", targetHz: 50 });
    const ownIds = new Set(sessionIds);

    expect(preview.candidateSessionIds.filter((id) => ownIds.has(id))).toEqual([]);
    const ownSkipped = preview.skipped.filter((item) => item.sessionIds.some((id) => ownIds.has(id)));
    expect(ownSkipped).toEqual(expect.arrayContaining([
      { sessionIds: [noFileId], reason: "missing" },
      { sessionIds: [missingId], reason: "missing" },
      { sessionIds: [unownedId], reason: "unowned" },
      { sessionIds: [motecId], reason: "unsupported-format" },
      { sessionIds: [legacyId], reason: "unsupported-format" },
      { sessionIds: [malformedId], reason: "unsupported-format" },
      { sessionIds: [nativeId], reason: "unreliable-time" },
    ]));
    expect(existsSync(legacy)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(inArray(sessions.id, [legacyId])).get())?.rawFile).toBe(legacy);
  });
});
