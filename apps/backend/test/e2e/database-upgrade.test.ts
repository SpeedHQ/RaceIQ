import { afterEach, expect, test } from "bun:test";
import Database from "libsql";
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import { LAP_DETECTOR_AC_EVO_ID } from "@raceiq/game-ac-evo/lap-detector";
import { CLASSIFICATION_MIGRATION_VERSION } from "@raceiq/backend-core/session-capture/classification-migration";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { decompressIfGzipSync, iterateSessionCaptureRecords, SESSION_SEGMENT_BOUNDARY, SESSION_SEGMENT_CONTEXT, SESSION_SEGMENT_CONTEXT_END } from "@raceiq/capture-formats/session/framing";
import { seedReleaseDatabase } from "./support/release-database";
const ROOT = resolve(import.meta.dir, "../../../..");
import { migrations } from "@raceiq/backend-core/db/migrations";
const COMPLETE = "[SessionRepair] Historical session reconciliation complete:";
const DEFERRED = "[StartupWorker] Deferred until recording layout migration completes";
const temporaryDirectories: string[] = [];
afterEach(async () => {
  // Wait until the test's stack has returned before collecting libsql's native
  // statement handles. Windows cannot unlink a database while those remain open.
  if (process.platform === "win32") { Bun.gc(true); await Bun.sleep(0); }
  for (const directory of temporaryDirectories.splice(0)) {
    const started = performance.now();
    console.log(`[Upgrade] Removing temporary data: ${directory}`);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log(`[Upgrade] Temporary data removed in ${Math.round(performance.now() - started)}ms`);
  }
}, 60_000);
type Session = { id: number; track_id: string; lap_detector_version: string | null; raw_file?: string; ownership?: string };


interface StartupBackend {
  ready(): Promise<void>;
  waitFor(marker: string): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  organize(): Promise<"success" | "failed">;
  releaseStage(): Promise<void>;
  output(): string;
  stop(): Promise<void>;
}

function environment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    NODE_ENV: "production",
    SERVER_HOST: "127.0.0.1",
    SERVER_PASSWORD: "",
    SERVER_ALLOWED_ORIGINS: "",
    RACEIQ_DISABLE_TRAY: "1",
  };
  delete env.RACEIQ_TEST_MODE;
  delete env.DB_IN_MEMORY;
  delete env.RACEIQ_TEST_DATA_DIR;
  delete env.PW_SEED_SCREENSHOTS;
  delete env.RACEIQ_CLASSIFICATION_TEST_BARRIER;
  delete env.RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR;
  return env;
}



async function command(args: string[], cwd = ROOT, env = process.env) {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return stdout;
}

function startBranch(dataDir: string, pauseStage: "historical" | "lmu-identity" | "race-results" | "dashboard" | null = null, udpPort = 0): StartupBackend {
  const proc = Bun.spawn([process.execPath, "--eval", `
    import { captureConsole } from "./server/runtime/logger";
    import { bootServer } from "./apps/backend/src/runtime/boot";
    import { MessageChannel } from "node:worker_threads";
    import { withSessionCaptureMaintenanceLock } from "./server/session-capture/cleanup";
    import { getRecordingStorageActivity } from "./server/session-capture/storage-activity";
    let pausedStage = ${JSON.stringify(pauseStage)};
    let testDependencies;
    let port1;
    if (pausedStage) {
      const channel = new MessageChannel();
      port1 = channel.port1;
      const port2 = channel.port2;
      port1.on("message", async (event) => {
        if (event.type === "stageEntered" && event.stage === pausedStage) {
          const resources = await withSessionCaptureMaintenanceLock(async () => getRecordingStorageActivity());
          console.log("[E2E] Stage resources:", JSON.stringify(resources));
          console.log("[E2E] Stage entered:", event.stage);
          return;
        }
        if (event.type === "stageEntered") console.log("[E2E] Stage entered:", event.stage);
        if (event.eventId) port1.postMessage({ type: "release", eventId: event.eventId });
      });
      testDependencies = { workerPort: port2 };
    }
    let control;
    control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/shutdown") {
        process.emit("message", { type: "shutdown" });
        setTimeout(() => control.stop(), 0);
      } else {
        pausedStage = null;
        port1?.postMessage({ type: "release-all" });
      }
      return new Response(null, { status: 204 });
    } });
    console.log("[E2E] Stage control:", control.port);
    captureConsole();
    const backend = await bootServer({ httpPort: 0, udpPort: ${udpPort}, recordingGameId: null, testDependencies });
    const authSetup = await fetch("http://127.0.0.1:" + backend.httpServer.port + "/api/auth/setup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: null, exposureConfirmed: true }),
    });
    if (authSetup.status !== 200 && authSetup.status !== 409) throw new Error("Fixture auth setup failed: " + authSetup.status);
    console.log("[E2E] Backend HTTP:", backend.httpServer.port);
  `], { cwd: ROOT, env: environment(dataDir), stdout: "pipe", stderr: "pipe" });
  let output = "";
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      if (output.length > 100_000) output = output.slice(-100_000);
    }
  };
  const drained = Promise.all([consume(proc.stdout), consume(proc.stderr)]);
  let exited = false;
  let stopPromise: Promise<void> | null = null;
  void proc.exited.then(() => { exited = true; });
  const waitFor = async (marker: string) => {
    const deadline = Date.now() + 180_000;
    while (!output.includes(marker)) {
      if (exited || Date.now() >= deadline) throw new Error(`Branch startup did not reach ${marker}:\n${output}`);
      await Bun.sleep(10);
    }
  };
  return {
    async request(path, init) {
      await waitFor("[E2E] Backend HTTP:");
      const match = output.match(/\[E2E\] Backend HTTP: (\d+)/);
      if (!match) throw new Error("Backend HTTP port missing");
      return fetch(`http://127.0.0.1:${match[1]}${path}`, init);
    },
    async ready() {
      await waitFor(COMPLETE);
      expect(output).not.toContain("reconciliation failed:");
    },
    waitFor,
    async releaseStage() {
      await waitFor("[E2E] Stage control:");
      const match = output.match(/\[E2E\] Stage control: (\d+)/);
      if (!match) throw new Error("Stage control port missing");
      const response = await fetch(`http://127.0.0.1:${match[1]}`, { method: "POST" });
      expect(response.status).toBe(204);
    },
    async organize() {
      const moveDeadline = Date.now() + 180_000;
      while (Date.now() < moveDeadline) {
        const moveResponse = await this.request("/api/storage/recording-directory");
        if (!moveResponse.ok) throw new Error(`Recording-directory status returned ${moveResponse.status}`);
        const move = await moveResponse.json() as { state: string };
        if (move.state !== "moving") break;
        await Bun.sleep(25);
      }
      let response: Response;
      do {
        response = await this.request("/api/storage/layout-migration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (response.status !== 409) break;
        const body = await response.clone().json() as { code?: string };
        if (body.code !== "MOVE_ACTIVE") break;
        await Bun.sleep(25);
      } while (Date.now() < moveDeadline);
      if (response.status !== 202) throw new Error(`Layout migration returned ${response.status}: ${await response.text()}`);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const statusResponse = await this.request("/api/storage/layout-migration", { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        if (!statusResponse.ok) throw new Error(`Layout status returned ${statusResponse.status}`);
        const result = await statusResponse.json() as { progress: { status: string } };
        if (result.progress.status === "success") return "success";
        if (result.progress.status === "partial" || result.progress.status === "error") return "failed";
        await Bun.sleep(25);
      }
      throw new Error(`Layout migration did not finish:\n${output}`);
    },
    output: () => output,
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (!exited) {
          await waitFor("[E2E] Stage control:");
          const match = output.match(/\[E2E\] Stage control: (\d+)/);
          if (!match) throw new Error("Backend control port missing");
          try {
            const response = await fetch(`http://127.0.0.1:${match[1]}/shutdown`);
            expect(response.status).toBe(204);
          } catch {
            await proc.exited;
          }
        }
        await proc.exited;
        await drained;
      })();
      return stopPromise;
    },
  };
}

test("startup preserves ambiguous historical Tourist classification without changing stored laps", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-release-upgrade-"));
  let backend: StartupBackend | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const { dataDir } = await seedReleaseDatabase(temporary);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const before = database.prepare("SELECT id,lap_detector_version FROM sessions ORDER BY id").all() as Array<{ id: number; lap_detector_version: string | null }>;
    expect(before.every((session) => session.lap_detector_version !== null)).toBe(true);
    // Deliberately stale results distinguish replay from a marker-only migration.
    database.exec("UPDATE laps SET lap_time=999, notes='preserved lap annotation', is_favorite=1; UPDATE sessions SET track_id='obsolete layout', notes='preserved session annotation', is_favorite=1;");
    // Keep ordinary startup profile assignment separate from classification preservation.
    database.exec("UPDATE laps SET profile_id=1 WHERE profile_id IS NULL");
    const lapMetadata = database.prepare("SELECT id,session_id,notes,is_favorite,profile_id,car_setup,tune_id,experiment_id,experiment_version_id FROM laps ORDER BY id").all();

    const firstRecording = database.prepare("SELECT raw_file, ownership FROM sessions ORDER BY id LIMIT 1").get() as { raw_file: string; ownership: string };
    // Full-frame conversion is a prerequisite, not part of folder organization.
    // Preserve the release capture's frame ordinals when its byte encoding changes.
    const releaseBytes = decompressIfGzipSync(readFileSync(firstRecording.raw_file));
    const indexedLaps = database.prepare("SELECT id,raw_byte_offset FROM laps ORDER BY id").all() as Array<{ id: number; raw_byte_offset: number }>;
    const requestedOffsets = new Set(indexedLaps.map((lap) => lap.raw_byte_offset));
    const ordinals = new Map<number, number>();
    let ordinal = 0;
    for (const record of iterateSessionCaptureRecords(releaseBytes)) {
      if (record.kind !== "frame") continue;
      if (requestedOffsets.has(record.offset)) ordinals.set(record.offset, ordinal);
      ordinal++;
    }
    const converted = await convertSeedFramesToSparse("ac-evo", (function* () {
      for (const record of iterateSessionCaptureRecords(releaseBytes)) {
        if (record.kind === "frame") yield { frame: record.frame, frameTimeMs: record.frameTimeMs };
        else if (record.kind === "segment-boundary") yield SESSION_SEGMENT_BOUNDARY;
        else if (record.kind === "segment-context") yield SESSION_SEGMENT_CONTEXT;
        else if (record.kind === "segment-context-end") yield SESSION_SEGMENT_CONTEXT_END;
      }
    })());
    const gameDirectory = join(dataDir, "sessions", "ac-evo");
    const legacyPath = join(gameDirectory, "tourist.bin");
    try {
      mkdirSync(gameDirectory, { recursive: true });
      copyFileSync(converted.path, legacyPath);
      const requestedOrdinals = new Set(ordinals.values());
      const convertedOffsets = new Map<number, number>();
      ordinal = 0;
      for (const record of iterateSessionCaptureRecords(readFileSync(converted.path))) {
        if (record.kind !== "frame") continue;
        if (requestedOrdinals.has(ordinal)) convertedOffsets.set(ordinal, record.offset);
        ordinal++;
      }
      for (const lap of indexedLaps) {
        const oldOrdinal = ordinals.get(lap.raw_byte_offset);
        const offset = oldOrdinal === undefined ? undefined : convertedOffsets.get(oldOrdinal);
        if (offset === undefined) throw new Error(`Release lap ${lap.id} has no corresponding converted source frame`);
        database.prepare("UPDATE laps SET raw_byte_offset=? WHERE id=?").run(offset, lap.id);
      }
    } finally {
      converted.cleanup();
    }
    database.prepare("UPDATE sessions SET raw_file=?").run(legacyPath);
    const ownerDirectory = firstRecording.ownership === "others" ? "others" : "own";
    const collision = join(gameDirectory, ownerDirectory, basename(legacyPath));
    const legacyBytes = readFileSync(legacyPath);
    backend = startBranch(dataDir);
    await backend.waitFor(DEFERRED);
    const consentStatus = await backend.request("/api/storage/layout-migration");
    expect(consentStatus.status).toBe(200);
    expect((await consentStatus.json() as { fileCount: number }).fileCount).toBeGreaterThan(0);
    expect(readFileSync(legacyPath)).toEqual(legacyBytes);
    expect(database.prepare("SELECT DISTINCT raw_file FROM sessions").all()).toEqual([{ raw_file: legacyPath }]);
    database.exec("UPDATE sessions SET capture_format_version=1, lap_detector_version=NULL");
    expect(database.prepare("SELECT id FROM sessions WHERE track_id='obsolete layout'").all()).toHaveLength(before.length);
    expect(database.prepare("SELECT id FROM laps WHERE lap_time=999").all().length).toBeGreaterThan(0);
    const deferredBackend = backend;
    await deferredBackend.stop();
    expect(deferredBackend.output()).not.toContain(COMPLETE);
    backend = undefined;
    // Seed conflict before starting the backend that will attempt migration.
    const collisionSessionId = database.prepare(`
      INSERT INTO sessions (game_id, raw_file, lap_detector_version, capture_format_version)
      VALUES ('ac-evo', ?, ?, 1)
    `).run(collision, LAP_DETECTOR_AC_EVO_ID).lastInsertRowid;
    mkdirSync(dirname(collision), { recursive: true });
    writeFileSync(collision, "pre-existing user capture");
    backend = startBranch(dataDir, "historical");
    await backend.waitFor(DEFERRED);
    expect(await backend.organize()).toBe("failed");
    expect(readFileSync(collision, "utf8")).toBe("pre-existing user capture");
    expect(readFileSync(legacyPath).length).toBeGreaterThan(0);
    expect(database.prepare("SELECT id FROM sessions WHERE track_id='obsolete layout'").all()).toHaveLength(before.length);
    expect(database.prepare("SELECT id FROM laps WHERE lap_time=999").all().length).toBeGreaterThan(0);
    expect(backend.output()).not.toContain(COMPLETE);
    database.prepare("DELETE FROM sessions WHERE id=?").run(collisionSessionId);
    await rm(collision);
    expect(await backend.organize()).toBe("success");
    await backend.waitFor("[E2E] Stage entered: historical");
    expect(backend.output()).toContain('[E2E] Stage resources: {"imports":0,"relocating":false}');
    expect(() => readFileSync(join(dataDir, "recording-layout-migration.json"))).toThrow();
    expect(database.prepare("SELECT DISTINCT raw_file FROM sessions").all()).toEqual([{ raw_file: collision }]);
    expect(database.prepare("SELECT id FROM laps WHERE lap_time=999").all().length).toBeGreaterThan(0);
    await backend.releaseStage();
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    expect(backend.output().split("[StartupWorker] Starting dashboard processor")).toHaveLength(2);
    expect(database.prepare("SELECT id,session_id,notes,is_favorite,profile_id,car_setup,tune_id,experiment_id,experiment_version_id FROM laps ORDER BY id").all()).toEqual(lapMetadata);
    expect(database.prepare("SELECT notes,is_favorite FROM sessions").all()).toEqual(before.map(() => ({ notes: "preserved session annotation", is_favorite: 1 })));
    const after = database.prepare("SELECT id,track_id,lap_detector_version,raw_file,ownership FROM sessions ORDER BY id").all() as Session[];
    expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id));
    for (const session of after) {
      expect(session.track_id).toBe("obsolete layout");
      expect(session.raw_file).toBe(join(gameDirectory, session.ownership === "others" ? "others" : "own", basename(legacyPath)));
    }
    const finishes = database.prepare("SELECT lap_time FROM laps ORDER BY id").all() as Array<{ lap_time: number }>;
    expect(finishes.map((lap) => lap.lap_time)).toEqual(lapMetadata.map(() => 999));
    expect(database.prepare("SELECT id FROM laps WHERE lap_time=999").all().length).toBeGreaterThan(0);
    await backend.stop();
    backend = undefined;
    database.exec("UPDATE laps SET lap_time=123.456");
    const recordingRoot = join(dataDir, "sessions");
    const destinations = [...new Set(after.map((session) => session.raw_file!))];
    writeFileSync(join(dataDir, "recording-layout-migration.json"), JSON.stringify({
      version: 1, root: recordingRoot, destination: recordingRoot, phase: "relocating",
      entries: [{
        source: legacyPath, destinations, published: destinations,
        digest: createHash("sha256").update(legacyBytes).digest("hex"), cutover: true,
        references: after.map((session) => ({ sessionId: session.id, oldPath: legacyPath, newPath: session.raw_file })),
      }],
      progress: { status: "running", done: 1, total: 1, migrated: 1, failed: 0, error: null },
    }));
    backend = startBranch(dataDir);
    await backend.waitFor(DEFERRED);
    const recoveredStatus = await backend.request("/api/storage/layout-migration");
    expect((await recoveredStatus.json() as { fileCount: number }).fileCount).toBe(0);
    expect(backend.output()).not.toContain(COMPLETE);
    expect(await backend.organize()).toBe("success");
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    const sessionsBeforeClassification = database.prepare("SELECT * FROM sessions ORDER BY id").all();
    const lapsBeforeClassification = database.prepare("SELECT * FROM laps ORDER BY id").all();
    let outcomes = database.prepare("SELECT state,reason FROM classification_migration_recordings").all() as Array<{ state: string; reason: string | null }>;
    const deadline = Date.now() + 180_000;
    while (outcomes.length === 0 || outcomes.some((row) => row.state === "pending" || row.state === "running")) {
      if (Date.now() >= deadline) throw new Error(`Historical classification did not settle: ${JSON.stringify(outcomes)}`);
      await Bun.sleep(20);
      outcomes = database.prepare("SELECT state,reason FROM classification_migration_recordings").all() as typeof outcomes;
    }
    expect(database.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBeforeClassification);
    expect(database.prepare("SELECT * FROM laps ORDER BY id").all()).toEqual(lapsBeforeClassification);
    expect(outcomes.some((row) => row.state === "failed" || row.state === "limited")).toBe(true);
    expect(outcomes).toContainEqual({ state: "limited", reason: "ambiguous_match" });
    const resumedTimes = database.prepare("SELECT lap_time FROM laps ORDER BY id").all() as Array<{ lap_time: number }>;
    expect(resumedTimes.map((lap) => lap.lap_time)).toEqual(lapMetadata.map(() => 123.456));
    expect(database.prepare("SELECT id,session_id,notes,is_favorite,profile_id,car_setup,tune_id,experiment_id,experiment_version_id FROM laps ORDER BY id").all()).toEqual(lapMetadata);
  } finally {
    await backend?.stop();
    database?.close();
    database = undefined;
    temporaryDirectories.push(temporary);
  }
}, 600_000);

test("startup discovers Tourist in already-processed AC Evo recordings and does not replay successes twice", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-evo-layout-backfill-"));
  const dataDir = join(temporary, "data");
  mkdirSync(dataDir);
  let backend: StartupBackend | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const fixture = join(temporary, "ac-evo-tourist.bin.gz");
    writeFileSync(fixture, Buffer.concat([1, 2].map((part) =>
      readFileSync(join(ROOT, `test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part${part}`)),
    )));
    await command([process.execPath, "run", "db:seed", "--games=ac-evo", `--fixtures=${fixture}`], ROOT, environment(dataDir));
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    // Exercise replay for captures recorded after the classification upgrade.
    database.prepare("UPDATE classification_migration_meta SET version=?,cutoff_session_id=0").run(CLASSIFICATION_MIGRATION_VERSION);
    // Simulate an installation that completed reconciliation before the Tourist-layout migration.
    database.exec(`
      DELETE FROM schema_migrations WHERE version=78;
      UPDATE laps SET lap_time=999;
    `);
    database.prepare("UPDATE sessions SET track_id='obsolete layout', lap_detector_version=?").run(LAP_DETECTOR_AC_EVO_ID);
    const before = database.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: number }>;
    expect(before.length).toBeGreaterThan(0);

    backend = startBranch(dataDir);
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    await backend.stop();
    backend = undefined;
    const after = database.prepare("SELECT id,track_id,lap_detector_version FROM sessions ORDER BY id").all() as Array<{ id: number; track_id: string; lap_detector_version: string | null }>;
    expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id));
    for (const session of after) {
      expect(session.track_id).toBe('["Nurburgring","Touristenfahrten"]');
      expect(session.lap_detector_version).toBe(LAP_DETECTOR_AC_EVO_ID);
    }
    const finishes = database.prepare("SELECT lap_time FROM laps WHERE is_valid=1 AND invalid_reason IS NULL ORDER BY lap_time").all() as Array<{ lap_time: number }>;
    expect(finishes.map((lap) => lap.lap_time)).toEqual([398.781, 401.277]);
    expect(database.prepare("SELECT id FROM laps WHERE lap_time=999").all()).toEqual([]);

    // A replay would overwrite this sentinel; successful sessions must be skipped on restart.
    database.exec("UPDATE laps SET lap_time=123.456 WHERE is_valid=1 AND invalid_reason IS NULL");
    backend = startBranch(dataDir);
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    const restarted = database.prepare("SELECT lap_time FROM laps WHERE is_valid=1 AND invalid_reason IS NULL").all() as Array<{ lap_time: number }>;
    expect(restarted.map((lap) => lap.lap_time)).toEqual([123.456, 123.456]);
  } finally {
    await backend?.stop();
    database?.close();
    database = undefined;
    temporaryDirectories.push(temporary);
  }
}, 240_000);
test("stop drains a paused startup stage and suppresses every successor", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-startup-stop-"));
  const dataDir = join(temporary, "data");
  mkdirSync(dataDir);
  let backend: StartupBackend | undefined;
  try {
    backend = startBranch(dataDir, "historical");
    await backend.waitFor("[E2E] Stage entered: historical");
    expect((await backend.request("/api/storage/layout-migration")).status).toBe(200);
    await Promise.all([backend.stop(), backend.stop()]);
    expect(backend.output()).not.toContain("[E2E] Stage entered: lmu-identity");
    expect(backend.output()).not.toContain("[LMU] Session identity backfill");
    expect(backend.output()).not.toContain("[RaceResults] Backfill");
    expect(backend.output()).not.toContain("[StartupWorker] Starting dashboard processor");
    expect(backend.output()).not.toContain("Shutdown grace expired");
  } finally {
    await backend?.stop();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("current ambiguous and nonrace results remain terminal across real backend restart", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-startup-terminal-"));
  const dataDir = join(temporary, "data");
  mkdirSync(dataDir);
  let backend: StartupBackend | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    await command([process.execPath, "--eval", `
      import { initDb, closeDb } from "./server/db/index";
      await initDb();
      closeDb();
    `], ROOT, environment(dataDir));
    database = new Database(join(dataDir, "app.db"));
    const insert = database.prepare("INSERT INTO sessions(game_id,car_id,track_id,session_type,lap_detector_version,capture_format_version) VALUES('ac-evo','Test car',?, ?, ?,1)");
    for (const sessionType of ["race", "practice"]) {
      const sessionId = insert.run('["Nurburgring","Touristenfahrten"]', sessionType, LAP_DETECTOR_AC_EVO_ID).lastInsertRowid;
      database.prepare("INSERT INTO laps(session_id,lap_number,lap_time) VALUES(?,1,100)").run(sessionId);
    }
    backend = startBranch(dataDir);
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    await backend.stop();
    backend = undefined;
    const terminal = database.prepare("SELECT session_id,session_type,outcome_status,processor_version,updated_at FROM session_results ORDER BY session_id").all() as Array<{ session_id: number; session_type: string; outcome_status: string; processor_version: string }>;
    expect(terminal).toHaveLength(2);
    expect(terminal.some((row) => row.session_type === "race" && row.outcome_status === "unavailable")).toBe(true);
    expect(terminal.some((row) => row.session_type === "practice")).toBe(true);
    database.exec(`
      CREATE TRIGGER reject_completed_result_insert BEFORE INSERT ON session_results BEGIN SELECT RAISE(ABORT,'completed result replayed'); END;
      CREATE TRIGGER reject_completed_result_update BEFORE UPDATE ON session_results BEGIN SELECT RAISE(ABORT,'completed result replayed'); END;
    `);
    backend = startBranch(dataDir);
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    expect((await backend.request("/api/storage/layout-migration")).status).toBe(200);
    expect(database.prepare("SELECT session_id,session_type,outcome_status,processor_version,updated_at FROM session_results ORDER BY session_id").all()).toEqual(terminal);
    expect(backend.output()).not.toContain("completed result replayed");
  } finally {
    await backend?.stop();
    database?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

for (const journalState of ["unfinished", "malformed", "unreadable"] as const) {
  test(`${journalState} layout journal blocks startup with zero legacy files`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), "raceiq-startup-journal-"));
    const dataDir = join(temporary, "data");
    mkdirSync(dataDir);
    let backend: StartupBackend | undefined;
    try {
      await command([process.execPath, "--eval", `
        import { initDb, client } from "./server/db/index";
        await initDb();
        await client.close();
      `], ROOT, environment(dataDir));
      const root = join(dataDir, "sessions");
      mkdirSync(root, { recursive: true });
      const journalPath = join(dataDir, "recording-layout-migration.json");
      const journal = journalState === "malformed" ? "{invalid" : JSON.stringify({
        version: 1, root, destination: root, phase: "relocating", entries: [],
        progress: { status: "running", done: 0, total: 0, migrated: 0, failed: 0, error: null },
      });
      writeFileSync(journalPath, journal);
      if (journalState === "unreadable") chmodSync(journalPath, 0);
      backend = startBranch(dataDir);
      await backend.waitFor(DEFERRED);
      const response = await backend.request("/api/storage/layout-migration");
      expect(response.status).toBe(200);
      const status = await response.json() as { fileCount: number; progress: { status: string; error: string } };
      expect(status.fileCount).toBe(0);
      expect(status.progress.status).toBe("error");
      if (journalState !== "unreadable") expect(readFileSync(journalPath, "utf8")).toBe(journal);
      expect(backend.output()).not.toContain(COMPLETE);
      expect(backend.output()).not.toContain("[StartupWorker] Starting dashboard processor");
      if (journalState === "unfinished") {
        expect(await backend.organize()).toBe("success");
        await backend.ready();
        await backend.waitFor("[StartupWorker] Starting dashboard processor");
        expect(() => readFileSync(journalPath)).toThrow();
        expect(backend.output().split("[StartupWorker] Starting dashboard processor")).toHaveLength(2);
      } else {
        const retry = await backend.request("/api/storage/layout-migration", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        expect(retry.status).toBe(500);
        if (journalState === "unreadable") chmodSync(journalPath, 0o600);
        expect(readFileSync(journalPath, "utf8")).toBe(journal);
      }
    } finally {
      await backend?.stop();
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
}

test.each([true, false])("recording splitting completes with UDP conflict %s", async (conflict) => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-udp-conflict-"));
  const dataDir = join(temporary, "data");
  const occupied = dgram.createSocket("udp4");
  let backend: StartupBackend | undefined;
  try {
    const listening = Promise.withResolvers<void>();
    occupied.once("error", listening.reject);
    occupied.bind(0, "0.0.0.0", listening.resolve);
    await listening.promise;
    const port = conflict ? occupied.address().port : 0;
    await command([process.execPath, "run", "db:seed", "--games=fm-2023"], ROOT, environment(dataDir));
    backend = startBranch(dataDir, null, port);
    if (!conflict) await backend.waitFor("[UDP] Listening on");
    const initial = await backend.request("/api/storage/split-migration");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      sessionCount: 3, progress: { status: "idle", done: 0, total: 3 },
    });
    const confirmed = await backend.request("/api/storage/split-migration", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(confirmed.status).toBe(202);
    const deadline = Date.now() + 30_000;
    let progress;
    do {
      const response = await backend.request("/api/storage/split-migration");
      expect(response.status).toBe(200);
      progress = await response.json() as { sessionCount: number; progress: { status: string; done: number; total: number; migrated: number; failed: number } };
      if (progress.progress.status !== "running") break;
      // The separate backend process owns the real split-queue timer.
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    expect(progress).toMatchObject({
      sessionCount: 0, progress: { status: "success", done: 3, total: 3, migrated: 3, failed: 0 },
    });
  } finally {
    await backend?.stop();
    occupied.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

for (const captureFailure of ["missing", "corrupt"] as const) {
test(`${captureFailure} historical capture preserves pending repairs while HTTP remains available`, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-startup-blocked-"));
  const dataDir = join(temporary, "data");
  mkdirSync(dataDir);
  let backend: StartupBackend | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const fixture = join(temporary, "ac-evo-tourist.bin.gz");
    writeFileSync(fixture, Buffer.concat([1, 2].map((part) =>
      readFileSync(join(ROOT, `test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part${part}`)),
    )));
    await command([process.execPath, "run", "db:seed", "--games=ac-evo", `--fixtures=${fixture}`], ROOT, environment(dataDir));
    const corruptCapture = join(temporary, "broken-sparse.bin");
    if (captureFailure === "corrupt") writeFileSync(corruptCapture, Buffer.from([255, 255, 255, 127]));
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    // Keep this broken new capture outside the historical classification inventory.
    database.prepare("UPDATE classification_migration_meta SET version=?,cutoff_session_id=0").run(CLASSIFICATION_MIGRATION_VERSION);
    const previousFiles = database.prepare("SELECT DISTINCT raw_file FROM sessions").all() as Array<{ raw_file: string }>;
    const originalCapture = readFileSync(previousFiles[0]!.raw_file);
    database.exec("UPDATE sessions SET notes='preserve repair annotation', is_favorite=1");
    const history = database.prepare("SELECT id,session_id,lap_time FROM laps ORDER BY id").all();
    for (const recording of previousFiles) rmSync(recording.raw_file, { force: true });
    database.prepare("UPDATE sessions SET raw_file = ?, lap_detector_version = NULL").run(corruptCapture);

    backend = startBranch(dataDir);
    await backend.waitFor("[StartupWorker] Historical session reconciliation failed: Startup reconciliation incomplete:");
    expect(backend.output()).toContain("[Server] HTTP/WS server listening");
    expect((await backend.request("/api/storage/layout-migration")).status).toBe(200);
    expect(database.prepare("SELECT id,session_id,lap_time FROM laps ORDER BY id").all()).toEqual(history);
    const pending = database.prepare("SELECT lap_detector_version,notes,is_favorite,raw_file FROM sessions").all() as Array<{ lap_detector_version: string | null; notes: string; is_favorite: number; raw_file: string }>;
    expect(pending.every((row) => row.lap_detector_version === null && row.notes === "preserve repair annotation" && row.is_favorite === 1 && row.raw_file === corruptCapture)).toBe(true);
    expect(backend.output()).not.toContain("[LMU] Session identity backfill");
    expect(backend.output()).not.toContain("[RaceResults] Backfill");
    expect(backend.output()).not.toContain("[StartupWorker] Starting dashboard processor");
    await backend.stop();
    writeFileSync(corruptCapture, originalCapture);
    backend = startBranch(dataDir);
    await backend.ready();
    await backend.waitFor("[StartupWorker] Starting dashboard processor");
    expect(database.prepare("SELECT id FROM sessions WHERE lap_detector_version IS NULL").all()).toEqual([]);
    expect(database.prepare("SELECT notes,is_favorite FROM sessions").all()).toEqual(pending.map(() => ({ notes: "preserve repair annotation", is_favorite: 1 })));
  } finally {
    await backend?.stop();
    database?.close();
    database = undefined;
    temporaryDirectories.push(temporary);
  }
}, 240_000);
}

for (const failure of ["lmu", "lmu-numeric", "race"] as const) {
  test(`${failure} incomplete result blocks dependent startup stages`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), `raceiq-startup-${failure}-blocked-`));
    const dataDir = join(temporary, "data");
    mkdirSync(dataDir);
    let backend: StartupBackend | undefined;
    let database: InstanceType<typeof Database> | undefined;
    try {
      await command([process.execPath, "--eval", `
        import { initDb, client } from "./server/db/index";
        await initDb();
        await client.close();
      `], ROOT, environment(dataDir));
      database = new Database(join(dataDir, "app.db"));
      database.exec("PRAGMA busy_timeout=5000;");
      database.prepare(`
        INSERT INTO sessions (game_id, car_id, track_id, lap_detector_version, capture_format_version)
        VALUES (?, ?, ?, ?, 1)
      `).run(
        failure !== "race" ? "lmu" : "ac-evo",
        failure === "lmu-numeric" ? "12345" : failure === "lmu" ? "" : "Test car",
        failure === "lmu-numeric" ? "67890" : failure === "lmu" ? "" : '["Nurburgring","Touristenfahrten"]',
        failure !== "race" ? LAP_DETECTOR_ID : LAP_DETECTOR_AC_EVO_ID,
      );
      database.exec("INSERT INTO laps (session_id, lap_number, lap_time) VALUES (1, 1, 100)");
      if (failure === "race") {
        // Exercise the real result writer against a controlled persistence failure.
        database.exec(`
          CREATE TRIGGER reject_result_write BEFORE INSERT ON session_results BEGIN
            SELECT RAISE(ABORT, 'controlled race-result write failure');
          END;
        `);
      }
      backend = startBranch(dataDir);
      const stage = failure !== "race" ? "LMU session identity backfill" : "Race-result backfill";
      await backend.waitFor(`[StartupWorker] ${stage} failed: Startup reconciliation incomplete:`);
      await backend.stop();
      expect(backend.output()).toContain(COMPLETE);
      if (failure !== "race") {
        expect(backend.output()).toContain("unresolved=1");
        expect(backend.output()).not.toContain("[RaceResults] Backfill");
      } else {
        expect(database.prepare("SELECT session_id FROM session_results").all()).toEqual([]);
        expect(backend.output()).toContain("errors=1");
      }
      expect(backend.output()).not.toContain("[StartupWorker] Starting dashboard processor");
      expect(backend.output()).not.toContain("Shutdown grace expired");
      backend = undefined;
    } finally {
      await backend?.stop();
      database?.close();
      database = undefined;
      temporaryDirectories.push(temporary);
    }
  }, 60_000);
}

for (const history of ["v75", "upstream-v76", "frequency-v76", "frequency-v77", "upstream-v80", "upstream-v81", "conflicting-v81"] as const) {
  test(`recording frequency migration upgrades ${history} through production initialization`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "raceiq-frequency-upgrade-"));
    let database: InstanceType<typeof Database> | undefined;
    try {
      await command([process.execPath, "--eval", `
        import { createClient } from "@libsql/client/sqlite3";
        import { join } from "node:path";
        import { bootstrap, runMigrations } from "./server/test-support/db/migrations";
        const client = createClient({ url: "file:" + join(process.env.DATA_DIR, "app.db") });
        try {
          await bootstrap(client);
          await runMigrations(client, ${history === "upstream-v81" ? 81 : history === "upstream-v80" ? 80 : 75});
        } finally {
          client.close();
        }
      `], ROOT, environment(dataDir));
      database = new Database(join(dataDir, "app.db"));
      database.exec(`
        INSERT INTO sessions (game_id, lap_detector_version)
        VALUES ('ac-evo', 'stored-evo-detector'), ('iracing', 'stored-iracing-detector');
      `);
      if (history === "upstream-v81") {
        database.exec("UPDATE sessions SET downsampled_frequency_hz = 50");
      }
      if (history === "upstream-v76") {
        database.exec(`
          UPDATE sessions SET lap_detector_version = NULL WHERE game_id = 'ac-evo';
          INSERT INTO schema_migrations (version, name)
          VALUES (76, 'reconcile all AC Evo recordings to discover Tourist layouts');
          UPDATE sessions SET lap_detector_version = 'stored-evo-detector' WHERE game_id = 'ac-evo';
        `);
      } else if (history === "frequency-v76" || history === "frequency-v77" || history === "conflicting-v81") {
        database.exec(`
          ALTER TABLE sessions ADD COLUMN downsampled_frequency_hz INTEGER;
          UPDATE sessions SET downsampled_frequency_hz = 50;
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (${history === "frequency-v77" ? 77 : 76}, 'persist archival recording frequency caps', '2026-10-01 12:00:00');
        `);
        if (history === "frequency-v77") {
          database.exec("INSERT INTO schema_migrations (version, name) VALUES (76, 'reconcile all AC Evo recordings to discover Tourist layouts')");
        }
        if (history === "conflicting-v81") {
          database.exec("INSERT INTO schema_migrations (version, name) VALUES (81, 'unknown migration')");
        }
      }
      database.close();
      database = undefined;
      const initializeArgs = [process.execPath, "--eval", `
        import { initDb, client } from "./server/db";
        try { await initDb(); } finally { client.close(); }
      `];
      if (history === "conflicting-v81") {
        await expect(command(initializeArgs, ROOT, environment(dataDir))).rejects.toThrow("Recording frequency migration conflicts with the recorded database history");
      } else {
        await command(initializeArgs, ROOT, environment(dataDir));
        await command(initializeArgs, ROOT, environment(dataDir)); // Verify repeated startup is safe.
      }
      database = new Database(join(dataDir, "app.db"));
      const rows = database.prepare("SELECT game_id, lap_detector_version FROM sessions ORDER BY id").all();
      expect(rows).toEqual([
        { game_id: "ac-evo", lap_detector_version: history === "v75" || history === "frequency-v76" ? null : "stored-evo-detector" },
        { game_id: "iracing", lap_detector_version: "stored-iracing-detector" },
      ]);
      const ledger = database.prepare("SELECT version, name FROM schema_migrations WHERE version >= 76 ORDER BY version").all();
      expect(ledger).toEqual(history === "conflicting-v81" ? [
        { version: 76, name: "persist archival recording frequency caps" },
        { version: 81, name: "unknown migration" },
      ] : migrations.filter((migration) => migration.version >= 76).map(({ version, name }) => ({ version, name })));
      const hasFrequencyCap = history === "frequency-v76" || history === "frequency-v77" || history === "conflicting-v81" || history === "upstream-v81";
      expect(database.prepare("SELECT downsampled_frequency_hz FROM sessions ORDER BY id").all()).toEqual([
        { downsampled_frequency_hz: hasFrequencyCap ? 50 : null },
        { downsampled_frequency_hz: hasFrequencyCap ? 50 : null },
      ]);
      if (history === "frequency-v76" || history === "frequency-v77") {
        expect(database.prepare("SELECT applied_at FROM schema_migrations WHERE version = 81").get()).toMatchObject({
          applied_at: "2026-10-01 12:00:00",
        });
      }
    } finally {
      database?.close();
      database = undefined;
      temporaryDirectories.push(dataDir);
    }
  }, 60_000);
}
