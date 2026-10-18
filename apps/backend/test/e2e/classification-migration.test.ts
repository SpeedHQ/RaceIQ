import { encodeFrameLength, encodeMetaFrame, encodeParserBootstrapFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords, iterateSessionFrames, PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { openCaptureArchive, prepareSplitWindows, splitCapturePromise, type DetectedLapWindow } from "@raceiq/capture-splitting";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { initServerGameAdapters } from "../../src/games/init";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createClient } from "@libsql/client/sqlite3";
import { bootstrap, runMigrations } from "@raceiq/backend-core/test-support/db/migrations";
import Database from "libsql";
import { cp, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dgram from "node:dgram";
import { ReplayedUdpDataSource } from "@raceiq/backend-core/test-support/recordings/replayed-udp-data-source";
import type { ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";
import { createAccMigrationFixture, prepareOrganizedReleaseData, seedReleaseDatabase } from "./support/release-database";
import { gunzipSync } from "node:zlib";
import { cloneReleaseData } from "./support/clone-release-data";
import { ROOT, command, startUpgradeServer, upgradeEnvironment, type UpgradeServer } from "./support/upgrade-server";
import { F1_HEADER_SIZE } from "@raceiq/capture-formats/f1-2025/f1-wire";
import type { ServerGameAdapter } from "@raceiq/backend-core/games/types";

function prepareLegacyWindows(source: SessionCaptureSource, windows: readonly DetectedLapWindow[], game: ServerGameAdapter) {
  return prepareSplitWindows({
    windows,
    source: () => iterateSessionCaptureRecordsFromSource(source, { strict: true, allowLegacyFullFrames: true }),
    codec: {
      gameId: game.id,
      appendsDelayedFinishFrame: game.appendsDelayedFinishFrame,
      createState: () => game.createParserState(),
      ...(game.captureParserCheckpoint ? { captureCheckpoint: (state: unknown) => game.captureParserCheckpoint!(state) } : {}),
      ...(game.restoreParserCheckpoint ? { restoreCheckpoint: (state: unknown, bytes: Uint8Array) => game.restoreParserCheckpoint!(state, Buffer.from(bytes)) } : {}),
      parseFrame: (bytes: Uint8Array, state: unknown) => game.tryParse(Buffer.from(bytes), state),
    },
    bootstrapVersion: PARSER_BOOTSTRAP_VERSION,
  });
}

let baseline: string;
let f1Baseline: string;
let temporary: string;
let freshClassifications: unknown[];
let freshRawSource: string;

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "raceiq-classification-upgrade-"));
  const supportedAccFixture = createAccMigrationFixture(temporary);
  const seeded = await seedReleaseDatabase(temporary, {
    gameId: "acc",
    paths: [supportedAccFixture],
  });
  baseline = seeded.dataDir;
  await prepareOrganizedReleaseData(baseline);
  f1Baseline = join(temporary, "f1-data");
  await command([process.execPath, "run", "db:seed", "--games=f1-2025", `--fixtures=${join(ROOT, "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz")}`], seeded.releaseDir, upgradeEnvironment(f1Baseline));
  await prepareOrganizedReleaseData(f1Baseline);
  // Assign a driver explicitly; ordinary startup separately backfills legacy NULL profiles.
  for (const dataDir of [baseline, f1Baseline]) {
    const fixture = new Database(join(dataDir, "app.db"));
    fixture.exec("UPDATE laps SET profile_id=1 WHERE profile_id IS NULL;");
    fixture.close();
  }
  const freshData = join(temporary, "fresh-data");
  await command([process.execPath, "run", "db:seed", "--games=acc", `--fixtures=${supportedAccFixture}`], ROOT, upgradeEnvironment(freshData));
  const freshDatabase = new Database(join(freshData, "app.db"));
  freshClassifications = freshDatabase.prepare("SELECT lap_number,classification FROM laps ORDER BY lap_number").all();
  const freshSource = freshDatabase.prepare("SELECT raw_file FROM sessions WHERE EXISTS(SELECT 1 FROM laps WHERE laps.session_id=sessions.id) ORDER BY id LIMIT 1").get() as { raw_file: string };
  freshRawSource = freshSource.raw_file;
  freshDatabase.close();
}, 600_000);

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function status(address: string): Promise<ClassificationMigrationStatus> {
  const response = await fetch(`${address}/api/sessions/classification-migration-status`);
  if (!response.ok) throw new Error(`Migration status ${response.status}: ${await response.text()}`);
  return response.json();
}

async function openUpgrade(dataDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const server = startUpgradeServer(dataDir, extraEnv);
  try {
    const address = await server.address();
    const access = await fetch(`${address}/api/auth/status`).then((response) => response.json()) as { pending: boolean };
    if (access.pending) {
      const response = await fetch(`${address}/api/auth/setup`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: address },
        body: JSON.stringify({ password: null, exposureConfirmed: true }),
      });
      if (!response.ok) throw new Error(`Access setup ${response.status}: ${await response.text()}`);
    }
    return { server, address };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

async function settled(address: string) {
  const deadline = Date.now() + 180_000;
  let snapshot = await status(address);
  // The production server runs in another process; fake clocks cannot advance its worker.
  while (snapshot.total === 0 || snapshot.status === "running") {
    if (Date.now() >= deadline) throw new Error(`Migration did not settle: ${JSON.stringify(snapshot)}`);
    await Bun.sleep(50);
    snapshot = await status(address);
  }
  return snapshot;
}
async function prepareCurrentSchema(dataDir: string): Promise<void> {
  const client = createClient({ url: pathToFileURL(join(dataDir, "app.db")).href });
  try {
    await bootstrap(client);
    await runMigrations(client);
  } finally {
    client.close();
  }
}

function preservedLaps(database: InstanceType<typeof Database>) {
  return database.prepare("SELECT * FROM laps ORDER BY id").all().map((row) => {
    const { classification: _classification, is_valid: _valid, invalid_reason: _reason,
      capture_chunk_id: _captureChunk, source_frame_start: _sourceFrameStart, source_frame_count: _sourceFrameCount, ...preserved } = row as Record<string, unknown>;
    return preserved;
  });
}

async function sourceChecksums(database: InstanceType<typeof Database>) {
  const sources = database.prepare("SELECT DISTINCT raw_file FROM sessions WHERE raw_file IS NOT NULL ORDER BY raw_file").all() as Array<{ raw_file: string }>;
  const checksums = [];
  for (const source of sources) {
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(source.raw_file).stream()) hash.update(chunk);
    checksums.push({ rawFile: source.raw_file, sha256: hash.digest("hex") });
  }
  return checksums;
}

test("normal boot classifies historical recordings in place and skips completed work after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-normal-"));
  const dataDir = join(directory, "data");
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    await cloneReleaseData(baseline, dataDir);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000; UPDATE laps SET notes='migration invariant', is_favorite=1;");
    database.exec(`INSERT INTO experiments(id,game_id,name) VALUES(9001,'acc','Migration invariant');
      INSERT INTO experiment_versions(id,experiment_id,version,label) VALUES(9001,9001,1,'Preserved arm');
      UPDATE laps SET experiment_id=9001,experiment_version_id=9001,experiment_excluded=1,experiment_excluded_source='manual';`);
    database.exec("UPDATE laps SET is_valid=0,invalid_reason=CASE lap_number WHEN 1 THEN 'inlap' WHEN 2 THEN 'manually invalid' WHEN 3 THEN 'outlap' ELSE invalid_reason END WHERE lap_number IN (1,2,3)");
    expect(database.prepare("SELECT lap_number,is_valid,invalid_reason FROM laps WHERE lap_number IN (1,3) ORDER BY lap_number").all()).toEqual([
      { lap_number: 1, is_valid: 0, invalid_reason: "inlap" },
      { lap_number: 3, is_valid: 0, invalid_reason: "outlap" },
    ]);
    const original = preservedLaps(database);
    const originalBytes = await sourceChecksums(database);
    expect(original.length).toBeGreaterThan(0);
    let running = await openUpgrade(dataDir);
    server = running.server;
    const first = await settled(running.address);
    expect(first.completed).toBeGreaterThan(0);
    expect(first.failed).toBe(0);
    expect(first.aggregatesPending).toBe(false);
    expect(preservedLaps(database)).toEqual(original);
    expect(database.prepare("SELECT id FROM laps WHERE classification IS NULL").all()).toEqual([]);
    expect(database.prepare("SELECT lap_number,classification FROM laps ORDER BY lap_number").all()).toEqual(freshClassifications);
    expect(database.prepare("SELECT lap_number,is_valid,invalid_reason FROM laps ORDER BY lap_number").all()).toEqual([
      { lap_number: 1, is_valid: 1, invalid_reason: null },
      { lap_number: 2, is_valid: 0, invalid_reason: "manually invalid" },
      { lap_number: 3, is_valid: 0, invalid_reason: "game reported invalid" },
    ]);
    const attempts = database.prepare("SELECT recording_id,attempt,state FROM classification_migration_recordings ORDER BY recording_id").all();
    await server.stop();
    running = await openUpgrade(dataDir);
    server = running.server;
    const second = await settled(running.address);
    expect(second.completed).toBe(first.completed);
    expect(database.prepare("SELECT recording_id,attempt,state FROM classification_migration_recordings ORDER BY recording_id").all()).toEqual(attempts);
    expect(preservedLaps(database)).toEqual(original);
    expect(await sourceChecksums(database)).toEqual(originalBytes);
    expect(database.prepare("SELECT lap_number,is_valid,invalid_reason FROM laps ORDER BY lap_number").all()).toEqual([
      { lap_number: 1, is_valid: 1, invalid_reason: null },
      { lap_number: 2, is_valid: 0, invalid_reason: "manually invalid" },
      { lap_number: 3, is_valid: 0, invalid_reason: "game reported invalid" },
    ]);
  } finally {
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

test("missing source is visible attention without retries or metadata loss; feature Retry durably requeues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-missing-"));
  const dataDir = join(directory, "data");
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    await cloneReleaseData(baseline, dataDir);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const source = database.prepare("SELECT raw_file FROM sessions WHERE EXISTS(SELECT 1 FROM laps WHERE laps.session_id=sessions.id) ORDER BY id LIMIT 1").get() as { raw_file: string };
    const repairBackup = join(directory, "repair-backup.bin");
    await cp(source.raw_file, repairBackup);
    const missing = join(directory, "missing.bin");
    database.prepare("UPDATE sessions SET raw_file=? WHERE raw_file=?").run(missing, source.raw_file);
    database.exec("UPDATE laps SET is_valid=0,invalid_reason='outlap' WHERE id=(SELECT MIN(id) FROM laps)");
    const originalLaps = preservedLaps(database);
    const running = await openUpgrade(dataDir);
    server = running.server;
    const first = await settled(running.address);
    expect(first.status).toBe("attention");
    expect(first.limited).toBeGreaterThan(0);
    expect(first.failed).toBe(0);
    expect(database.prepare("SELECT classification,is_valid,invalid_reason FROM laps ORDER BY id LIMIT 1").get()).toMatchObject({ classification: "out_lap", is_valid: 0, invalid_reason: "outlap" });
    const response = await fetch(`${running.address}/api/sessions/classification-migration-recordings?limit=100`);
    expect(response.status).toBe(200);
    const list = await response.json() as { recordings: Array<{ recordingId: string; reason: string; retryable: boolean }> };
    const unresolved = list.recordings.find((recording) => recording.reason === "missing_source");
    expect(unresolved).toMatchObject({ reason: "missing_source", retryable: true });
    expect(JSON.stringify(list)).not.toContain(missing);
    expect((await fetch(`${running.address}/api/sessions/classification-migration-recordings?limit=0`)).status).toBe(400);
    expect((await fetch(`${running.address}/api/sessions/classification-migration-recordings?limit=101`)).status).toBe(400);
    expect((await fetch(`${running.address}/api/sessions/classification-migration-retry`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: running.address },
      body: JSON.stringify({ recordingId: "unknown-recording" }),
    })).status).toBe(404);
    const id = unresolved!.recordingId;
    const attempt = database.prepare("SELECT attempt FROM classification_migration_recordings WHERE recording_id=?").get(id) as { attempt: number };
    await server.stop();
    const restarted = await openUpgrade(dataDir);
    server = restarted.server;
    await settled(restarted.address);
    expect(database.prepare("SELECT attempt FROM classification_migration_recordings WHERE recording_id=?").get(id)).toMatchObject({ attempt: attempt.attempt });
    // Repair bytes at the same historical source path without invoking manual reprocess.
    await cp(repairBackup, missing);
    const retry = await fetch(`${restarted.address}/api/sessions/classification-migration-retry`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: restarted.address },
      body: JSON.stringify({ recordingId: id }),
    });
    expect(retry.status).toBe(202);
    const repaired = await settled(restarted.address);
    expect(repaired.completed).toBeGreaterThan(0);
    expect(preservedLaps(database)).toEqual(originalLaps);
  } finally {
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

for (const barrier of ["beforeTransaction", "insideTransaction", "afterCommitBeforeAggregates"] as const) {
  test(`SIGKILL at ${barrier} preserves recording atomicity and drains committed aggregate work`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-crash-"));
    const dataDir = join(directory, "data");
    const barrierDir = join(directory, "barriers");
    let server: UpgradeServer | undefined;
    let database: InstanceType<typeof Database> | undefined;
    try {
      await cloneReleaseData(baseline, dataDir);
      await mkdir(barrierDir);
      database = new Database(join(dataDir, "app.db"));
      database.exec("PRAGMA busy_timeout=5000;");
      database.exec("UPDATE laps SET is_valid=0,invalid_reason='outlap' WHERE id=(SELECT id FROM laps WHERE is_valid=1 AND lap_time>0 ORDER BY lap_time LIMIT 1)");
      const quality = database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all();
      const original = preservedLaps(database);
      server = startUpgradeServer(dataDir, {
        RACEIQ_E2E: "1",
        RACEIQ_CLASSIFICATION_TEST_BARRIER: barrier,
        RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR: barrierDir,
      });
      await server.address();
      const deadline = Date.now() + 180_000;
      // This marker is emitted by a separate real process, not an advanceable test clock.
      while (!await Bun.file(join(barrierDir, `${barrier}.reached`)).exists()) {
        if (Date.now() >= deadline) throw new Error(`Missing ${barrier} barrier:\n${server.output}`);
        await Bun.sleep(20);
      }
      await server.stop();
      const committed = database.prepare("SELECT attempt,state FROM classification_migration_recordings ORDER BY recording_id").all() as Array<{ attempt: number; state: string }>;
      expect(committed.length).toBeGreaterThan(0);
      if (barrier === "afterCommitBeforeAggregates") {
        expect(committed.some((recording) => recording.state === "completed")).toBe(true);
        expect(database.prepare("SELECT session_id FROM dashboard_summary_state WHERE metadata_dirty=1 AND source_revision>published_revision").all().length).toBeGreaterThan(0);
        expect(database.prepare("SELECT id FROM laps WHERE classification IS NULL").all()).toEqual([]);
      } else {
        expect(committed.every((recording) => recording.state !== "completed")).toBe(true);
        expect(database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all()).toEqual(quality);
        expect(database.prepare("SELECT classification FROM laps WHERE invalid_reason='outlap'").all()).toEqual([{ classification: "out_lap" }]);
      }
      expect(preservedLaps(database)).toEqual(original);
      const restarted = await openUpgrade(dataDir);
      server = restarted.server;
      const recovered = await settled(restarted.address);
      expect(recovered.completed).toBeGreaterThan(0);
      expect(recovered.failed).toBe(0);
      expect(recovered.aggregatesPending).toBe(false);
      expect(preservedLaps(database)).toEqual(original);
      expect(database.prepare("SELECT session_id FROM dashboard_summary_state WHERE metadata_dirty<>0 OR source_revision<>published_revision").all()).toEqual([]);
      const summaries = database.prepare(`SELECT s.session_id,s.best_lap_seconds,e.best FROM dashboard_session_summaries s
        JOIN (SELECT session_id,MIN(lap_time) AS best FROM laps WHERE is_valid=1 AND lap_time>0
          AND (classification IS NULL OR classification='pace') GROUP BY session_id) e ON e.session_id=s.session_id`).all() as Array<{ session_id: number; best_lap_seconds: number; best: number }>;
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) expect(summary.best_lap_seconds).toBeCloseTo(summary.best, 6);
      if (barrier === "afterCommitBeforeAggregates") {
        expect(database.prepare("SELECT attempt,state FROM classification_migration_recordings ORDER BY recording_id").all()).toEqual(committed);
      }
    } finally {
      await server?.stop();
      database?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 240_000);
}

for (const defect of ["ambiguous_match", "corrupt_source"] as const) {
  test(`${defect} fails the recording atomically without changing saved lap identity`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-failure-"));
    const dataDir = join(directory, "data");
    let server: UpgradeServer | undefined;
    let database: InstanceType<typeof Database> | undefined;
    try {
      if (defect === "ambiguous_match") {
        const seeded = await seedReleaseDatabase(directory, {
          gameId: "acc",
          paths: [join(ROOT, "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz")],
        });
        await prepareOrganizedReleaseData(seeded.dataDir);
        database = new Database(join(seeded.dataDir, "app.db"));
        database.exec("UPDATE laps SET profile_id=1 WHERE profile_id IS NULL;");
        expect(database.prepare("SELECT raw_byte_offset,raw_frame_count FROM laps ORDER BY lap_number DESC LIMIT 1").get()).toMatchObject({
          raw_byte_offset: 66_133_836,
          raw_frame_count: 281,
        });
      } else {
        await cloneReleaseData(baseline, dataDir);
        database = new Database(join(dataDir, "app.db"));
      }
      database.exec("PRAGMA busy_timeout=5000;");
      if (defect === "corrupt_source") {
        const corrupt = join(directory, "corrupt.bin");
        // A declared frame with a truncated payload must not be accepted as partial success.
        await Bun.write(corrupt, Buffer.from([0, 16, 0, 0, 1, 2, 3]));
        database.prepare("UPDATE sessions SET raw_file=?").run(corrupt);
      }
      const original = preservedLaps(database);
      const quality = database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all();
      const running = await openUpgrade(dataDir);
      server = running.server;
      const snapshot = await settled(running.address);
      expect(snapshot.status).toBe("attention");
      expect(snapshot.failed).toBeGreaterThan(0);
      const response = await fetch(`${running.address}/api/sessions/classification-migration-recordings`);
      expect(response.status).toBe(200);
      const list = await response.json() as { recordings: Array<{ state: string; reason: string }> };
      expect(list.recordings.some((recording) => recording.state === "failed" && recording.reason === defect)).toBe(true);
      expect(preservedLaps(database)).toEqual(original);
      expect(database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all()).toEqual(quality);
      expect(database.prepare("SELECT id FROM laps WHERE classification IS NOT NULL").all()).toEqual([]);
    } finally {
      await server?.stop();
      database?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 240_000);
}

test("bounded decoding leaves HTTP, supported imports, and manual processing usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-concurrent-"));
  const dataDir = join(directory, "data");
  const barrierDir = join(directory, "barriers");
  let server: UpgradeServer | undefined;
  try {
    await cloneReleaseData(baseline, dataDir);
    await mkdir(barrierDir);
    const running = await openUpgrade(dataDir, {
      RACEIQ_E2E: "1",
      RACEIQ_CLASSIFICATION_TEST_BARRIER: "duringDecodeBatch",
      RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR: barrierDir,
    });
    server = running.server;
    const deadline = Date.now() + 180_000;
    // The barrier belongs to the production worker in another process.
    while (!await Bun.file(join(barrierDir, "duringDecodeBatch.reached")).exists()) {
      if (Date.now() >= deadline) throw new Error(`Decode barrier not reached:\n${server.output}`);
      await Bun.sleep(20);
    }
    const health = await fetch(`${running.address}/api/auth/status`, { signal: AbortSignal.timeout(5000) });
    expect(health.status).toBe(200);
    expect((await status(running.address)).running).toBe(1);
    const body = new FormData();
    body.append("file", Bun.file(freshRawSource), "current-acc.bin");
    body.append("ownership", "others");
    const imported = await fetch(`${running.address}/api/laps/import`, {
      method: "POST", headers: { Origin: running.address }, body, signal: AbortSignal.timeout(30_000),
    });
    if (!imported.ok) throw new Error(`Concurrent import ${imported.status}: ${await imported.text()}`);
    expect((await imported.json()).imported).toBe(3);
    const database = new Database(join(dataDir, "app.db"));
    const session = database.prepare("SELECT id FROM sessions WHERE id>1 AND EXISTS(SELECT 1 FROM laps WHERE laps.session_id=sessions.id) ORDER BY id DESC LIMIT 1").get() as { id: number };
    database.close();
    const reprocessed = await fetch(`${running.address}/api/sessions/${session.id}/reprocess`, {
      method: "POST", headers: { Origin: running.address }, signal: AbortSignal.timeout(30_000),
    });
    if (!reprocessed.ok) throw new Error(`Concurrent reprocess ${reprocessed.status}: ${await reprocessed.text()}`);
    await Bun.write(join(barrierDir, "duringDecodeBatch.release"), "");
    const final = await settled(running.address);
    expect(final.failed).toBe(0);
    expect(final.aggregatesPending).toBe(false);
    expect(final.completed).toBeGreaterThan(0);
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

test("live UDP capture starts before paused historical decoding is released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-live-"));
  const dataDir = join(directory, "data");
  const barrierDir = join(directory, "barriers");
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  const reservation = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.bind(0, "127.0.0.1", resolve); });
    const bound = reservation.address();
    if (typeof bound === "string") throw new Error("UDP reservation did not bind TCP/IP");
    const udpPort = bound.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await cloneReleaseData(baseline, dataDir);
    await mkdir(barrierDir);
    const settings = await Bun.file(join(dataDir, "settings.json")).json();
    await Bun.write(join(dataDir, "settings.json"), JSON.stringify({ ...settings, recordingDirectory: join(dataDir, "sessions") }));
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const originalSessions = database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    const running = await openUpgrade(dataDir, {
      RACEIQ_E2E: "1",
      RACEIQ_UPGRADE_UDP_PORT: String(udpPort),
      RACEIQ_CLASSIFICATION_TEST_BARRIER: "duringDecodeBatch",
      RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR: barrierDir,
    });
    server = running.server;
    await server.udpReady();
    const deadline = Date.now() + 180_000;
    // Observe a separate production worker and OS UDP receive queue, not a fake clock.
    while (!await Bun.file(join(barrierDir, "duringDecodeBatch.reached")).exists()) {
      if (Date.now() >= deadline) throw new Error(`Decode barrier not reached:\n${server.output}`);
      await Bun.sleep(20);
    }
    const source = new ReplayedUdpDataSource(join(ROOT, "test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz"));
    // This real recording starts in menus; only race-on native packets can create a session.
    const active = source.packets.filter((packet) => packet.readInt32LE(0) === 1).slice(0, 80);
    expect(active).toHaveLength(80);
    const sender = dgram.createSocket("udp4");
    try {
      for (const packet of active) {
        await new Promise<void>((resolve, reject) => sender.send(packet, udpPort, "127.0.0.1", (error) => error ? reject(error) : resolve()));
      }
    } finally {
      sender.close();
    }
    let live = database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE raw_file IS NOT NULL").get() as { count: number };
    while (live.count <= originalSessions.count) {
      if (Date.now() >= deadline) throw new Error(`Live recorder blocked by backfill:\n${server.output}`);
      await Bun.sleep(20);
      live = database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE raw_file IS NOT NULL").get() as { count: number };
    }
    expect((await status(running.address)).running).toBe(1);
    await Bun.write(join(barrierDir, "duringDecodeBatch.release"), "");
  } finally {
    try { reservation.close(); } catch { /* Already released before the listener bound. */ }
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

test("#222 scalar-matching capture preserves ambiguous historical boundaries without a fabricated grid start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-start-evidence-"));
  const dataDir = join(directory, "data");
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    await cloneReleaseData(f1Baseline, dataDir);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    // The release's initial no-lap source also proves inventory includes unresolved empty recordings.
    database.prepare("UPDATE sessions SET raw_file=? WHERE NOT EXISTS(SELECT 1 FROM laps WHERE laps.session_id=sessions.id)").run(join(directory, "missing-empty-source.bin"));
    const original = preservedLaps(database);
    const quality = database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all();
    const running = await openUpgrade(dataDir);
    server = running.server;
    const snapshot = await settled(running.address);
    expect(snapshot.status).toBe("attention");
    expect(snapshot.limited).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(database.prepare("SELECT id FROM laps WHERE classification='grid_start'").all()).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM laps WHERE classification IS NULL").get()).toMatchObject({ count: 5 });
    expect(preservedLaps(database)).toEqual(original);
    expect(database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all()).toEqual(quality);
    const response = await fetch(`${running.address}/api/sessions/classification-migration-recordings`);
    const list = await response.json() as { recordings: Array<{ state: string; reason: string }> };
    // Its first stored range differs from current detection; four later exact matches cannot justify a partial commit.
    expect(list.recordings).toContainEqual(expect.objectContaining({ state: "failed", reason: "ambiguous_match" }));
    expect(list.recordings).toContainEqual(expect.objectContaining({ state: "limited", reason: "missing_source" }));
    const firstPageResponse = await fetch(`${running.address}/api/sessions/classification-migration-recordings?limit=1`);
    const firstPage = await firstPageResponse.json() as { recordings: Array<{ recordingId: string }>; nextCursor: string | null };
    expect(firstPage.recordings).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursorUrl = `${running.address}/api/sessions/classification-migration-recordings?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`;
    const secondPageResponse = await fetch(cursorUrl);
    expect(secondPageResponse.status).toBe(200);
    const secondPage = await secondPageResponse.json() as { recordings: Array<{ recordingId: string }> };
    expect(secondPage.recordings).toHaveLength(1);
    expect(secondPage.recordings[0]!.recordingId).not.toBe(firstPage.recordings[0]!.recordingId);
    const retry = await fetch(`${running.address}/api/sessions/classification-migration-retry`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: running.address },
      body: JSON.stringify({ recordingId: firstPage.recordings[0]!.recordingId }),
    });
    expect(retry.status).toBe(202);
    expect((await fetch(cursorUrl)).status).toBe(409);
  } finally {
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

test("same-path source replacement discards stale decoding before committing metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-source-change-"));
  const dataDir = join(directory, "data");
  const barrierDir = join(directory, "barriers");
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    await cloneReleaseData(baseline, dataDir);
    await mkdir(barrierDir);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const source = database.prepare("SELECT raw_file FROM sessions ORDER BY id LIMIT 1").get() as { raw_file: string };
    const original = preservedLaps(database);
    const quality = database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all();
    const running = await openUpgrade(dataDir, {
      RACEIQ_E2E: "1",
      RACEIQ_CLASSIFICATION_TEST_BARRIER: "duringDecodeBatch",
      RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR: barrierDir,
    });
    server = running.server;
    const deadline = Date.now() + 180_000;
    // Another process owns the decoder and open source descriptor.
    while (!await Bun.file(join(barrierDir, "duringDecodeBatch.reached")).exists()) {
      if (Date.now() >= deadline) throw new Error(`Decode barrier not reached:\n${server.output}`);
      await Bun.sleep(20);
    }
    const replacement = join(directory, "replacement.bin");
    await Bun.write(replacement, Buffer.from([0, 16, 0, 0, 1, 2, 3]));
    await rename(replacement, source.raw_file);
    await Bun.write(join(barrierDir, "duringDecodeBatch.release"), "");
    const final = await settled(running.address);
    expect(final.status).toBe("attention");
    expect(final.failed).toBe(1);
    expect(final.completed).toBe(0);
    expect(database.prepare("SELECT attempt,result_revision,reason FROM classification_migration_recordings").get()).toMatchObject({
      attempt: 2, result_revision: 0, reason: "corrupt_source",
    });
    expect(database.prepare("SELECT id FROM laps WHERE classification IS NOT NULL").all()).toEqual([]);
    expect(preservedLaps(database)).toEqual(original);
    expect(database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all()).toEqual(quality);
  } finally {
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);
test("idle inventory reconciliation tracks replacement and deleted source groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-inventory-"));
  const dataDir = join(directory, "data");
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    await cloneReleaseData(baseline, dataDir);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    database.close();
    database = undefined;
    const running = await openUpgrade(dataDir);
    server = running.server;
    await settled(running.address);
    database = new Database(join(dataDir, "app.db"));
    const recordings = async () => {
      const response = await fetch(`${running.address}/api/sessions/classification-migration-recordings?limit=100`);
      if (!response.ok) throw new Error(`Migration recordings ${response.status}: ${await response.text()}`);
      return (await response.json()) as { recordings: Array<{ recordingId: string }> };
    };
    const before = await recordings();
    const sessionRows = database.prepare("SELECT id,raw_file FROM sessions WHERE raw_file IS NOT NULL ORDER BY id").all() as Array<{ id: number; raw_file: string }>;
    expect(sessionRows.length).toBeGreaterThan(0);
    const originalSource = sessionRows[0]!.raw_file;
    const replacement = join(directory, "replacement-source.bin");
    await cp(originalSource, replacement);
    database.prepare("UPDATE sessions SET raw_file=? WHERE id=?").run(replacement, sessionRows[0]!.id);
    const deadline = Date.now() + 30_000;
    let afterReplacement = await recordings();
    // Worker runs in separate process; wait for observable inventory revision instead of fake timers.
    while (afterReplacement.recordings.map(({ recordingId }) => recordingId).join(",") ===
      before.recordings.map(({ recordingId }) => recordingId).join(",")) {
      if (Date.now() >= deadline) throw new Error("Replacement source inventory did not reconcile");
      await Bun.sleep(100);
      afterReplacement = await recordings();
    }
    expect(await Bun.file(replacement).exists()).toBe(true);
    expect(afterReplacement.recordings).not.toEqual(before.recordings);
    const sessionIds = sessionRows.map(({ id }) => id);
    const placeholders = sessionIds.map(() => "?").join(",");
    database.prepare(`DELETE FROM laps WHERE session_id IN (${placeholders})`).run(...sessionIds);
    database.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...sessionIds);
    let afterDeletion = await recordings();
    while (afterDeletion.recordings.length !== 0) {
      if (Date.now() >= deadline) throw new Error("Deleted source inventory did not reconcile");
      await Bun.sleep(100);
      afterDeletion = await recordings();
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE raw_file IS NOT NULL").get()).toMatchObject({ count: 0 });
    await unlink(replacement);
  } finally {
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);
for (const malformedBootstrap of [false, true]) {
  test(`production migration restores parser bootstrap before owned F1 frames${malformedBootstrap ? " or rejects mismatched bootstrap atomically" : ""}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-bootstrap-"));
    const dataDir = join(directory, "data");
    let database: InstanceType<typeof Database> | undefined;
    let server: UpgradeServer | undefined;
    try {
      initServerGameAdapters();
      const game = getServerGame("f1-2025");
      const state = game.createParserState();
      const nativePacket = (packetId: number, data: Buffer, time: number) => {
        const bytes = Buffer.alloc(F1_HEADER_SIZE + data.length);
        bytes.writeUInt16LE(2025, 0);
        bytes.writeUInt8(25, 2);
        bytes.writeUInt8(1, 3);
        bytes.writeUInt8(1, 5);
        bytes.writeUInt8(packetId, 6);
        bytes.writeBigUInt64LE(1n, 7);
        bytes.writeFloatLE(time, 15);
        bytes.writeUInt8(255, 28);
        data.copy(bytes, F1_HEADER_SIZE);
        return bytes;
      };
      const lapData = Buffer.alloc(57);
      lapData.writeUInt8(1, 33);
      for (const [id, data] of [[0, Buffer.alloc(60)], [1, Buffer.alloc(125)], [2, lapData], [6, Buffer.alloc(60)]] as const) {
        game.tryParse(nativePacket(id, data, 0), state);
      }
      game.tryParse(nativePacket(3, Buffer.from([83, 84, 76, 71, 5]), 1), state);
      game.tryParse(nativePacket(3, Buffer.from("LGOT"), 2), state);
      if (!game.captureParserCheckpoint) throw new Error("F1 parser checkpoint unavailable");
      const checkpoint = game.captureParserCheckpoint(state);
      if (!checkpoint) throw new Error("F1 parser checkpoint empty");
      lapData.writeUInt32LE(20_000, 4);
      const owned = nativePacket(2, lapData, 22);
      const prefix = Buffer.concat([
        encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeSegmentBoundaryFrame(),
        encodeParserBootstrapFrame(malformedBootstrap ? "acc" : "f1-2025", checkpoint),
      ]);
      const sourcePath = join(directory, "checkpoint-dependent.bin");
      await Bun.write(sourcePath, Buffer.concat([prefix, encodeFrameLength(owned.length), owned]));
      await cloneReleaseData(baseline, dataDir);
      database = new Database(join(dataDir, "app.db"));
      database.exec("DELETE FROM laps WHERE id<>(SELECT MIN(id) FROM laps); DELETE FROM sessions WHERE id NOT IN (SELECT session_id FROM laps)");
      const row = database.prepare("SELECT id,session_id FROM laps").get() as { id: number; session_id: number };
      database.prepare("UPDATE sessions SET game_id='f1-2025',car_id='0',track_id='0',raw_file=? WHERE id=?").run(sourcePath, row.session_id);
      database.prepare("UPDATE laps SET lap_number=1,lap_time=20,is_valid=0,invalid_reason='incomplete',raw_byte_offset=?,raw_frame_count=1 WHERE id=?").run(prefix.length, row.id);
      const original = preservedLaps(database);
      database.close();
      database = undefined;
      const running = await openUpgrade(dataDir);
      server = running.server;
      const result = await settled(running.address);
      database = new Database(join(dataDir, "app.db"));
      expect(result.completed).toBe(malformedBootstrap ? 0 : 1);
      expect(result.failed).toBe(malformedBootstrap ? 1 : 0);
      expect(database.prepare("SELECT classification,is_valid,invalid_reason FROM laps WHERE id=?").get(row.id)).toMatchObject({
        classification: malformedBootstrap ? null : "grid_start", is_valid: 0, invalid_reason: "incomplete",
      });
      expect(preservedLaps(database)).toEqual(original);
    } finally {
      await server?.stop();
      database?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 240_000);
}
test("production migration replays selected ACC trailing context without extending stored frame ranges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-trailing-context-"));
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  let sparse: { path: string; cleanup(): void } | undefined;
  try {
    initServerGameAdapters();
    const sourcePath = join(ROOT, "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz");
    const sourceBytes = gunzipSync(Buffer.from(await Bun.file(sourcePath).arrayBuffer()));
    sparse = await convertSeedFramesToSparse("acc", iterateSessionFrames(sourceBytes));
    const seeded = await seedReleaseDatabase(directory, { gameId: "acc", paths: [sparse.path] });
    await prepareOrganizedReleaseData(seeded.dataDir);
    database = new Database(join(seeded.dataDir, "app.db"));
    const row = database.prepare("SELECT l.id,l.session_id,l.lap_number,l.raw_byte_offset,l.raw_frame_count,s.raw_file,s.car_id,s.track_id FROM laps l JOIN sessions s ON s.id=l.session_id WHERE l.lap_number=3 AND l.raw_byte_offset IS NOT NULL AND l.raw_frame_count>1 ORDER BY l.id LIMIT 1").get() as {
      id: number; session_id: number; lap_number: number; raw_byte_offset: number; raw_frame_count: number;
      raw_file: string; car_id: string; track_id: string;
    };
    expect(row.raw_byte_offset).toBeGreaterThan(0);
    const source = { rawFile: row.raw_file, source: null, gameId: "acc" as const, carId: row.car_id, trackId: row.track_id };
    const prepared = await prepareLegacyWindows(source, [{
      lapId: String(row.id), lapNumber: row.lap_number, startByteOffset: row.raw_byte_offset, frameCount: row.raw_frame_count,
    }], getServerGame("acc"));
    const outputDirectory = join(directory, "selected");
    const manifest = await splitCapturePromise({
      sourcePath: row.raw_file, outputDirectory, gameId: "acc", sourceRevision: "classification-trailing-context",
      lapWindows: prepared,
    });
    const selected = manifest.chunks.find((chunk) => chunk.kind === "lap");
    if (!selected) throw new Error("Production split emitted no selected ACC lap");
    if (selected.ownedFrameCount === undefined || selected.ownedFrameByteOffset === undefined) {
      throw new Error("Selected ACC lap has no owned source window");
    }
    expect(selected.trailingContextFrameCount).toBe(1);
    let selectedPath: string;
    let selectedBytes: Buffer;
    if ("path" in selected) {
      selectedPath = join(outputDirectory, selected.path);
      selectedBytes = Buffer.from(await Bun.file(selectedPath).arrayBuffer());
    } else {
      selectedPath = join(outputDirectory, "selected-acc-lap.bin");
      if (!("archiveFile" in manifest)) throw new Error("Archive chunk has no archive manifest");
      const archive = await openCaptureArchive(join(outputDirectory, manifest.archiveFile), manifest);
      selectedBytes = await archive.readEntryBuffer(selected.entryName, selected.byteLength);
      await Bun.write(selectedPath, selectedBytes);
    }
    // Standalone exports mark non-owned primer/completion records explicitly.
    // Decode checkpoint groups before reframing so marker bytes cannot invalidate delta distances.
    const frames = [];
    for await (const record of iterateSessionCaptureRecordsFromSource({ ...source, rawFile: selectedPath, captureFormatVersion: 1 }, { strict: true })) {
      if (record.kind === "frame") frames.push(record);
    }
    const pieces = [encodeMetaFrame(frames.length), encodeSparseCaptureFormatFrame(), encodeSegmentBoundaryFrame()];
    let byteOffset = pieces.reduce((total, piece) => total + piece.length, 0);
    let ownedOffset = -1;
    let ownedCount = 0;
    let inContext = false;
    for (const record of frames) {
      const owned = record.offset >= selected.ownedFrameByteOffset! && ownedCount < selected.ownedFrameCount!;
      if (owned === inContext) {
        const marker = owned ? encodeSegmentContextEndFrame() : encodeSegmentContextFrame();
        pieces.push(marker);
        byteOffset += marker.length;
        inContext = !owned;
      }
      if (owned) {
        if (ownedOffset < 0) ownedOffset = byteOffset;
        ownedCount++;
      }
      const prefix = encodeFrameLength(record.frame.length, record.frameTimeMs);
      pieces.push(prefix, record.frame);
      byteOffset += prefix.length + record.frame.length;
    }
    if (inContext) pieces.push(encodeSegmentContextEndFrame());
    expect(ownedCount).toBe(selected.ownedFrameCount);
    selectedBytes = Buffer.concat(pieces);
    await Bun.write(selectedPath, selectedBytes);
    const selectedRecords = [...iterateSessionCaptureRecords(selectedBytes)];
    const contextIndex = selectedRecords.findLastIndex((record) => record.kind === "segment-context");
    const contextEndIndex = selectedRecords.findIndex((record, index) => index > contextIndex && record.kind === "segment-context-end");
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(contextEndIndex).toBeGreaterThan(contextIndex);
    expect(selectedRecords.slice(contextIndex + 1, contextEndIndex).filter((record) => record.kind === "frame")).toHaveLength(1);
    const ownedFrame = selectedRecords.find((record) => record.kind === "frame" && record.offset === ownedOffset);
    if (!ownedFrame || ownedFrame.kind !== "frame") throw new Error("Selected ACC split has no owned frame");
    database.prepare("DELETE FROM laps WHERE session_id=? AND id<>?").run(row.session_id, row.id);
    database.prepare("UPDATE sessions SET raw_file=? WHERE id=?").run(selectedPath, row.session_id);
    database.prepare("UPDATE laps SET raw_byte_offset=?,raw_frame_count=? WHERE id=?")
      .run(ownedFrame.offset, selected.ownedFrameCount, row.id);
    // Normal boot assigns unowned legacy laps to the default driver before migration.
    database.exec("UPDATE laps SET profile_id=1 WHERE profile_id IS NULL");
    const originalRanges = database.prepare("SELECT id,session_id,raw_byte_offset,raw_frame_count FROM laps ORDER BY id").all();
    const originalQuality = database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all();
    const original = preservedLaps(database);
    database.close();
    database = undefined;
    const running = await openUpgrade(seeded.dataDir);
    server = running.server;
    database = new Database(join(seeded.dataDir, "app.db"));
    const result = await settled(running.address);
    expect(result.completed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(database.prepare("SELECT classification FROM laps WHERE id=?").get(row.id)).toMatchObject({ classification: expect.any(String) });
    expect(database.prepare("SELECT id,session_id,raw_byte_offset,raw_frame_count FROM laps ORDER BY id").all()).toEqual(originalRanges);
    expect(database.prepare("SELECT id,is_valid,invalid_reason FROM laps ORDER BY id").all()).toEqual(originalQuality);
    expect(preservedLaps(database)).toEqual(original);
  } finally {
    await server?.stop();
    database?.close();
    sparse?.cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

test("production migration persists known incomplete LMU laps and updates other laps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-classification-incomplete-lmu-"));
  let server: UpgradeServer | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const seeded = await seedReleaseDatabase(directory, {
      gameId: "lmu",
      paths: [join(ROOT, "test/artifacts/laps/lmu-2026-09-19T20-09-44-686Z.bin.gz")],
    });
    await prepareOrganizedReleaseData(seeded.dataDir);
    await prepareCurrentSchema(seeded.dataDir);
    database = new Database(join(seeded.dataDir, "app.db"));
    database.exec("UPDATE laps SET profile_id=1 WHERE profile_id IS NULL;");
    const original = database.prepare("SELECT id,lap_number,classification,is_valid,invalid_reason FROM laps ORDER BY lap_number").all() as Array<{
      id: number; lap_number: number; classification: string | null; is_valid: number; invalid_reason: string | null;
    }>;
    const incomplete = original.find((lap) => lap.invalid_reason === "incomplete");
    if (!incomplete) throw new Error("LMU fixture has no known incomplete lap");
    const updateable = original.find((lap) => lap.id !== incomplete.id);
    if (!updateable) throw new Error("LMU fixture has no additional lap");
    database.prepare("UPDATE laps SET classification='legacy',is_valid=1,invalid_reason=NULL WHERE id=?").run(incomplete.id);
    database.prepare("UPDATE laps SET classification='legacy',is_valid=1,invalid_reason=NULL WHERE id=?").run(updateable.id);
    database.close();
    database = undefined;

    const running = await openUpgrade(seeded.dataDir);
    server = running.server;
    const result = await settled(running.address);
    expect(result.completed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    const rows = new Database(join(seeded.dataDir, "app.db"));
    try {
      expect(rows.prepare("SELECT classification,is_valid,invalid_reason FROM laps WHERE id=?").get(incomplete.id)).toMatchObject({
        classification: null, is_valid: 0, invalid_reason: "incomplete",
      });
      expect(rows.prepare("SELECT classification FROM laps WHERE id=?").get(updateable.id)).toMatchObject({
        classification: expect.not.stringMatching(/^legacy$/),
      });
      expect(rows.prepare("SELECT state,reason FROM classification_migration_recordings").all()).toContainEqual(
        expect.objectContaining({ state: "completed", reason: null }),
      );
    } finally {
      rows.close();
    }
  } finally {
    await server?.stop();
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);
