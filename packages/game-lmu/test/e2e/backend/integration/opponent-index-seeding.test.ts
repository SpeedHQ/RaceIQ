import { afterEach, describe, expect, test } from "bun:test";
import Database from "libsql";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LMU_DUMP_MAGIC, LMU_DUMP_VERSION } from "@raceiq/capture-formats/lmu/dump-decoder";
import { decompressIfGzipSync, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { SEED_MARKER } from "@raceiq/tooling-data/data/seed-db-options";
import { startOpponentColdLoadSeedProcess } from "../../../support/opponent-cold-load-server";

const REPO_ROOT = process.cwd();
const tempDirs: string[] = [];
function makeDataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "raceiq-lmu-seed-index-")));
  tempDirs.push(dir);
  return dir;
}
function assertInsideDataDir(dataDir: string, path: string): void {
  const relativePath = relative(dataDir, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new Error(`Refusing to modify path outside isolated seed data: ${path}`);
}
afterEach(async () => {
  for (const dataDir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(dataDir, { recursive: true, force: true }); break; }
      catch (error) {
        const isBusyOnWindows = process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EBUSY";
        if (!isBusyOnWindows || attempt === 9) throw error;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 200);
        await promise;
      }
    }
  }
});
function makeLmuSeedDump(dataDir: string): string {
  // Preserve native-v3 source frames; only adapt their container to the seed CLI format.
  const capture = decompressIfGzipSync(readFileSync(join(REPO_ROOT, "packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-grid-2026-10-22.bin.gz")));
  const frames = [...iterateSessionCaptureRecords(capture, 0, { strict: true })]
    .flatMap((record) => record.kind === "frame" ? [record.frame] : []);
  const dump = Buffer.alloc(16 + frames.reduce((size, frame) => size + 5 + frame.length, 0));
  LMU_DUMP_MAGIC.copy(dump);
  dump.writeUInt32LE(LMU_DUMP_VERSION, 8);
  dump.writeUInt32LE(frames.length, 12);
  let offset = 16;
  for (const frame of frames) {
    dump.writeUInt8(0, offset);
    dump.writeUInt32LE(frame.length, offset + 1);
    frame.copy(dump, offset + 5);
    offset += 5 + frame.length;
  }
  const path = join(dataDir, "lmu-seed.bin");
  writeFileSync(path, dump);
  return path;
}

async function runLmuSeed(dataDir: string, fixturePath: string, stage: string): Promise<{ code: number; output: string }> {
  console.error(`[E8] ${stage}: seed start`);
  const proc = Bun.spawn(["bun", "run", join(REPO_ROOT, "apps/backend/scripts/data/seed-db.ts"), "--games=lmu", `--fixtures=${fixturePath}`], {
    cwd: join(REPO_ROOT, "apps/backend"),
    env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "0", DB_IN_MEMORY: "0", SERVER_PASSWORD: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 150_000);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    console.error(`[E8] ${stage}: seed exit ${code}`);
    return { code, output: `[E8] ${stage}\n${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timeout);
  }
}

function readLmuSeedSnapshot(dataDir: string): {
  sessions: Array<{ id: number; rawFile: string }>;
  laps: Array<{ id: number; sessionId: number; lapNumber: number }>;
  sourceBytes: Array<{ path: string; sha256: string }>;
} {
  const database = new Database(join(dataDir, "app.db"), { readonly: true, fileMustExist: true });
  try {
    const sessions = database.prepare(
      "SELECT id, raw_file AS rawFile, capture_manifest_file AS captureManifestFile FROM sessions WHERE game_id = 'lmu' AND notes = ? ORDER BY id",
    ).all(SEED_MARKER) as Array<{ id: number; rawFile: string | null; captureManifestFile: string | null }>;
    const laps = database.prepare(
      "SELECT l.id, l.session_id AS sessionId, l.lap_number AS lapNumber FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.game_id = 'lmu' AND s.notes = ? ORDER BY l.id",
    ).all(SEED_MARKER) as Array<{ id: number; sessionId: number; lapNumber: number }>;
    const sourcePaths = new Set<string>();
    for (const session of sessions) {
      if (!session.rawFile) throw new Error(`Seeded LMU session ${session.id} has no native source file`);
      sourcePaths.add(session.rawFile);
      const manifestPath = session.captureManifestFile
        ? resolve(dataDir, session.captureManifestFile)
        : join(dirname(session.rawFile), "capture-manifest.json");
      if (!existsSync(manifestPath)) continue;
      sourcePaths.add(manifestPath);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { opponentCompanion?: { file?: unknown } };
      if (typeof manifest.opponentCompanion?.file === "string") {
        sourcePaths.add(resolve(dirname(manifestPath), manifest.opponentCompanion.file));
      }
    }
    const sourceBytes = [...sourcePaths].sort().map((path) => ({
      path: relative(dataDir, path),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
    return {
      sessions: sessions.map(({ id, rawFile }) => {
        if (!rawFile) throw new Error(`Seeded LMU session ${id} has no native source file`);
        return { id, rawFile };
      }),
      laps,
      sourceBytes,
    };
  } finally {
    database.close();
  }
}

async function readLmuSeedIndexStatus(dataDir: string, sessionId: number): Promise<{
  indexState: string;
  publicationPath: string | null;
  retention: { sourceRevision: string; opponentRetention: string };
}> {
  const source = `
    import { eq } from "drizzle-orm";
    import { closeDb, db, initDb } from "@raceiq/backend-core/db/index";
    import { sessions } from "@raceiq/backend-core/db/schema";
    import { getLmuOpponentIndexStatus } from "@raceiq/backend-core/session-capture/lmu-opponent-index-runtime";
    await initDb();
    try {
      const session = await db.select({
        rawFile: sessions.rawFile, captureManifestFile: sessions.captureManifestFile, source: sessions.source, gameId: sessions.gameId,
        carId: sessions.carId, trackId: sessions.trackId, captureFormatVersion: sessions.captureFormatVersion,
      }).from(sessions).where(eq(sessions.id, Number(process.env.SEED_SESSION_ID))).get();
      if (!session?.rawFile) throw new Error("Seed session has no native source path");
      const status = await getLmuOpponentIndexStatus({ ...session, rawFile: session.captureManifestFile ?? session.rawFile });
      console.log("INDEX_STATUS=" + JSON.stringify(status));
    } finally {
      await closeDb();
    }
  `;
  const proc = Bun.spawn(["bun", "--eval", source], {
    cwd: join(REPO_ROOT, "apps/backend"),
    env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "0", DB_IN_MEMORY: "0", SEED_SESSION_ID: String(sessionId) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  let code: number;
  let stdout: string;
  let stderr: string;
  try {
    [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  } finally {
    clearTimeout(timeout);
  }
  if (code !== 0) throw new Error(`LMU index status probe failed (${code}): ${stdout}\n${stderr}`);
  const statusLine = stdout.split("\n").find((line) => line.startsWith("INDEX_STATUS="));
  if (!statusLine) throw new Error(`LMU index status probe omitted result: ${stdout}\n${stderr}`);
  return JSON.parse(statusLine.slice("INDEX_STATUS=".length));
}

function expectSeedProcessClosed(result: { code: number; output: string }): void {
  expect(result.code, result.output).toBe(0);
  expect(result.output).toMatch(/\[DB Seed\] Durations: seed=[\d.]+ms, import=[\d.]+ms, index=[\d.]+ms\./);
}
describe("LMU opponent seed index reconciliation", () => {
  test("seed launch reconciles fresh, repeated, interrupted, missing, incompatible, and recording-deferred LMU indexes", async () => {
    const dataDir = makeDataDir();
    const fixturePath = makeLmuSeedDump(dataDir);
    const first = await runLmuSeed(dataDir, fixturePath, "fresh seed");
    expectSeedProcessClosed(first);
    const initial = readLmuSeedSnapshot(dataDir);
    expect(initial.sessions.length).toBeGreaterThan(0);
    console.error("[E8] fresh seed status probe");
    const firstStatus = await readLmuSeedIndexStatus(dataDir, initial.sessions[0]!.id);
    expect(firstStatus.indexState).toBe("ready");
    expect(firstStatus.retention.opponentRetention).toBe("retained");
    expect(typeof firstStatus.publicationPath).toBe("string");

    const repeated = await runLmuSeed(dataDir, fixturePath, "repeated seed");
    expectSeedProcessClosed(repeated);
    expect(repeated.output).toContain("Seed data already exists; nothing to do.");
    expect(readLmuSeedSnapshot(dataDir)).toEqual(initial);
    console.error("[E8] repeated seed status probe");
    const reused = await readLmuSeedIndexStatus(dataDir, initial.sessions[0]!.id);
    expect(reused.indexState).toBe("ready");
    expect(reused.publicationPath).toBe(firstStatus.publicationPath);

    const indexRoot = dirname(dirname(firstStatus.publicationPath!));
    assertInsideDataDir(dataDir, indexRoot);
    const stagingPath = join(indexRoot, ".staging-interrupted");
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(join(indexRoot, "state.json"), JSON.stringify({
      version: 1,
      indexState: "building",
      sourceRevision: firstStatus.retention.sourceRevision,
      publicationPath: null,
      error: null,
    }));
    const afterInterrupted = await runLmuSeed(dataDir, fixturePath, "interrupted-index repair");
    expectSeedProcessClosed(afterInterrupted);
    expect(existsSync(stagingPath)).toBe(false);
    console.error("[E8] interrupted repair status probe");
    const interruptedRepair = await readLmuSeedIndexStatus(dataDir, initial.sessions[0]!.id);
    expect(interruptedRepair.indexState).toBe("ready");
    expect(typeof interruptedRepair.publicationPath).toBe("string");

    const interruptedPublicationPath = interruptedRepair.publicationPath!;
    assertInsideDataDir(dataDir, interruptedPublicationPath);
    rmSync(dirname(interruptedPublicationPath), { recursive: true, force: true });
    const afterMissing = await runLmuSeed(dataDir, fixturePath, "missing-index repair");
    expectSeedProcessClosed(afterMissing);
    console.error("[E8] missing repair status probe");
    const missingRepair = await readLmuSeedIndexStatus(dataDir, initial.sessions[0]!.id);
    expect(missingRepair.indexState).toBe("ready");
    expect(missingRepair.publicationPath).not.toBe(interruptedPublicationPath);

    const incompatiblePublicationPath = missingRepair.publicationPath!;
    assertInsideDataDir(dataDir, incompatiblePublicationPath);
    const incompatibleIndex = JSON.parse(readFileSync(incompatiblePublicationPath, "utf8")) as Record<string, unknown>;
    incompatibleIndex.schemaVersion = 999;
    writeFileSync(incompatiblePublicationPath, JSON.stringify(incompatibleIndex));
    const afterIncompatible = await runLmuSeed(dataDir, fixturePath, "incompatible-index repair");
    expectSeedProcessClosed(afterIncompatible);
    expect(afterIncompatible.output).toContain("Seed data already exists; nothing to do.");
    console.error("[E8] incompatible repair status probe");
    const incompatibleRepair = await readLmuSeedIndexStatus(dataDir, initial.sessions[0]!.id);
    expect(incompatibleRepair.indexState).toBe("ready");
    expect(incompatibleRepair.publicationPath).not.toBe(incompatiblePublicationPath);
    expect(readLmuSeedSnapshot(dataDir)).toEqual(initial);
    const missingPublicationDirectory = dirname(incompatibleRepair.publicationPath!);
    assertInsideDataDir(dataDir, missingPublicationDirectory);
    rmSync(missingPublicationDirectory, { recursive: true, force: true });
    console.error("[E8] starting recording-deferred seed child");
    const deferredSeed = await startOpponentColdLoadSeedProcess({
      dataDir,
      fixturePaths: [fixturePath],
      holdAt: ["before-publication-fence", "reconciliation-deferred"],
    });
    let captureMayBeActive = false;
    try {
      console.error("[E8] waiting before-publication-fence barrier");
      const buildBarrier = await deferredSeed.waitForBarrier("before-publication-fence");
      if (!buildBarrier.sourcePath) throw new Error("Seed index build barrier omitted source path");
      captureMayBeActive = true;
      console.error("[E8] starting recording during held publication fence");
      await deferredSeed.startLmuOpponentCapture("seed-index-deferral", { opponents: true });
      console.error("[E8] recording started; requesting native frame feed");
      const frameFeed = deferredSeed.feedLmuOpponentFrames(12);
      console.error("[E8] awaiting pending recording intent while publication fence is held");
      let recordingIntentActive = await deferredSeed.isSessionActive();
      while (!recordingIntentActive) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        recordingIntentActive = await deferredSeed.isSessionActive();
      }
      expect(recordingIntentActive).toBe(true);
      console.error("[E8] recording intent active; releasing publication fence");
      await deferredSeed.releaseBarrier(buildBarrier.id);
      console.error("[E8] waiting reconciliation-deferred barrier");
      const deferredBarrier = await deferredSeed.waitForBarrier("reconciliation-deferred");
      expect(deferredBarrier.sourcePath).toBe(buildBarrier.sourcePath);
      console.error("[E8] awaiting frame feed");
      expect(await frameFeed).toBe(12);
      console.error("[E8] frame feed complete; checking active recorder");
      expect(await deferredSeed.isSessionActive()).toBe(true);
      console.error("[E8] recorder active; reading capture state");
      expect((await deferredSeed.getLmuOpponentCaptureState()).sessionId).not.toBeNull();
      console.error("[E8] capture state read");
      const pendingStatus = await deferredSeed.indexStatusForSession(initial.sessions[0]!.id) as {
        indexState: string;
        publicationPath: string | null;
      };
      expect(pendingStatus.indexState).not.toBe("ready");
      expect(await deferredSeed.isSessionActive()).toBe(true);
      console.error("[E8] waiting for worker-yielded event");
      await deferredSeed.waitForRuntimeEvent("worker-yielded", { sourcePath: buildBarrier.sourcePath });

      console.error("[E8] finalizing recording");
      await deferredSeed.finalizeLmuOpponentCapture();
      captureMayBeActive = false;
      expect(await deferredSeed.isSessionActive()).toBe(false);
      console.error("[E8] releasing reconciliation-deferred barrier");
      await deferredSeed.releaseBarrier(deferredBarrier.id);

      const [exit, stdout, stderr] = await Promise.all([deferredSeed.exit, deferredSeed.stdout, deferredSeed.stderr]);
      const output = `${stdout}\n${stderr}`;
      expect(exit).toMatchObject({ code: 0, signal: null });
      expectSeedProcessClosed({ code: exit.code ?? -1, output });
      expect(output).toContain("[DB Seed] Seed data already exists; nothing to do.");
      expect(output).toContain("[DB Seed] Opponent index pending; publication deferred for recording activity.");
      expect(output).not.toContain("[DB Seed] Opponent index ready");
      const deferredStatus = await readLmuSeedIndexStatus(dataDir, initial.sessions[0]!.id);
      expect(deferredStatus.indexState).not.toBe("ready");
      expect(readLmuSeedSnapshot(dataDir)).toEqual(initial);
    } finally {
      if (captureMayBeActive) await deferredSeed.finalizeLmuOpponentCapture().catch(() => {});
      await deferredSeed.stop();
    }
  }, 180_000);
});
