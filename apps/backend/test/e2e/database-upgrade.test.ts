import { expect, test } from "bun:test";
import Database from "libsql";
import { LAP_DETECTOR_AC_EVO_ID } from "@raceiq/game-ac-evo/lap-detector";
import { CLASSIFICATION_MIGRATION_VERSION } from "@raceiq/backend-core/session-capture/classification-migration";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


interface StartupBackend {
  ready(): Promise<void>;
  waitFor(marker: string): Promise<void>;
  organize(): Promise<"success" | "failed">;
  output(): string;
  stop(): Promise<void>;
}

function environment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, NODE_ENV: "production" };
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

function startBranch(dataDir: string): StartupBackend {
  const proc = Bun.spawn([process.execPath, "--eval", `
    import { captureConsole } from "./server/runtime/logger";
    import { bootServer } from "./apps/backend/src/runtime/boot";
    import { getLayoutMigrationStatus, startLayoutMigration } from "./server/session-capture/layout-migration";
    captureConsole();
    // Migration filesystem work can exceed Bun's HTTP idle timeout; the parent enforces a deadline.
    const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
      if (request.method === "POST") {
        void startLayoutMigration().catch((error) => console.error("[E2E] Layout migration admission failed", error));
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const status = await getLayoutMigrationStatus();
      if (status.progress.status === "success") {
        console.log("[E2E] Layout migration success");
        return Response.json({ status: "success" });
      }
      if (status.progress.status === "partial" || status.progress.status === "error") {
        console.log("[E2E] Layout migration failed");
        return Response.json({ status: "failed" });
      }
      return Response.json({ status: status.progress.status });
    } });
    console.log("[E2E] Migration control:", control.port);
    await bootServer({ httpPort: 0, udpPort: 0, recordingGameId: null });
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
  void proc.exited.then(() => { exited = true; });
  const waitFor = async (marker: string) => {
    const deadline = Date.now() + 180_000;
    while (!output.includes(marker)) {
      if (exited || Date.now() >= deadline) throw new Error(`Branch startup did not reach ${marker}:\n${output}`);
      await Bun.sleep(10);
    }
  };
  return {
    async ready() {
      await waitFor(COMPLETE);
      expect(output).not.toContain("reconciliation failed:");
    },
    waitFor,
    async organize() {
      await waitFor("[E2E] Migration control:");
      const match = output.match(/\[E2E\] Migration control: (\d+)/);
      if (!match) throw new Error("Migration control port missing");
      const url = `http://127.0.0.1:${match[1]}`;
      const response = await fetch(url, { method: "POST" });
      if (response.status !== 202) throw new Error(`Migration control returned ${response.status}`);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const statusResponse = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        if (!statusResponse.ok) throw new Error(`Migration control status returned ${statusResponse.status}`);
        const result = await statusResponse.json() as { status?: unknown };
        if (result.status === "success" || result.status === "failed") return result.status;
        await Bun.sleep(25);
      }
      throw new Error(`Layout migration did not finish:\n${output}`);
    },
    output: () => output,
    async stop() {
      if (!exited) proc.kill("SIGTERM");
      await proc.exited;
      await drained;
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
    // The classification upgrade must not replace stale timing or unrelated session identity.
    database.exec("UPDATE laps SET lap_time=999; UPDATE sessions SET track_id='obsolete layout';");

    const firstRecording = database.prepare("SELECT raw_file, ownership FROM sessions ORDER BY id LIMIT 1").get() as { raw_file: string; ownership: string };
    // Full-frame conversion is a prerequisite to this upgrade, separate from folder organization.
    const converted = await convertSeedFramesToSparse("ac-evo", (function* () {
      for (const record of iterateSessionCaptureRecords(decompressIfGzipSync(Buffer.from(readFileSync(firstRecording.raw_file))))) {
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
    } finally {
      converted.cleanup();
    }
    database.prepare("UPDATE sessions SET raw_file=?").run(legacyPath);
    const ownerDirectory = firstRecording.ownership === "others" ? "others" : "own";
    const collision = join(gameDirectory, ownerDirectory, basename(legacyPath));
    backend = startBranch(dataDir);
    await backend.waitFor(DEFERRED);
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
    backend = startBranch(dataDir);
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
    const sessionsBeforeClassification = database.prepare("SELECT * FROM sessions ORDER BY id").all();
    const lapsBeforeClassification = database.prepare("SELECT * FROM laps ORDER BY id").all();
    await backend.ready();
    const deadline = Date.now() + 180_000;
    let outcomes = database.prepare("SELECT state,reason FROM classification_migration_recordings").all() as Array<{ state: string; reason: string | null }>;
    // Another process owns the production backfill; observe durable terminal results.
    while (outcomes.length === 0 || outcomes.some((row) => row.state === "pending" || row.state === "running")) {
      if (Date.now() >= deadline) throw new Error(`Historical classification did not settle: ${JSON.stringify(outcomes)}`);
      await Bun.sleep(20);
      outcomes = database.prepare("SELECT state,reason FROM classification_migration_recordings").all() as typeof outcomes;
    }
    expect(database.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBeforeClassification);
    expect(database.prepare("SELECT * FROM laps ORDER BY id").all()).toEqual(lapsBeforeClassification);
    expect(outcomes.some((row) => row.state === "failed" || row.state === "limited")).toBe(true);
    expect(outcomes).toContainEqual({ state: "failed", reason: "ambiguous_match" });
  } finally {
    await backend?.stop();
    database?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      UPDATE sessions SET track_id='obsolete layout', lap_detector_version='ac_evo_lapdetector_v5';
      UPDATE laps SET lap_time=999;
    `);
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
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);
test("incomplete historical replay blocks later startup stages while HTTP remains available", async () => {
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
    writeFileSync(corruptCapture, Buffer.from([255, 255, 255, 127]));
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    // Keep this broken new capture outside the historical classification inventory.
    database.prepare("UPDATE classification_migration_meta SET version=?,cutoff_session_id=0").run(CLASSIFICATION_MIGRATION_VERSION);
    const previousFiles = database.prepare("SELECT DISTINCT raw_file FROM sessions").all() as Array<{ raw_file: string }>;
    for (const recording of previousFiles) rmSync(recording.raw_file, { force: true });
    database.prepare("UPDATE sessions SET raw_file = ?, lap_detector_version = NULL").run(corruptCapture);

    backend = startBranch(dataDir);
    await backend.waitFor("[StartupWorker] Historical session reconciliation failed: Startup reconciliation incomplete:");
    expect(backend.output()).toContain("[Server] HTTP/WS server listening");
    expect(backend.output()).not.toContain("[LMU] Session identity backfill");
    expect(backend.output()).not.toContain("[RaceResults] Backfill");
    expect(backend.output()).not.toContain("[StartupWorker] Starting dashboard processor");
  } finally {
    await backend?.stop();
    database?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 240_000);

for (const failure of ["lmu", "race"] as const) {
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
        failure === "lmu" ? "lmu" : "ac-evo",
        failure === "lmu" ? "" : "Test car",
        failure === "lmu" ? "" : '["Nurburgring","Touristenfahrten"]',
        failure === "lmu" ? LAP_DETECTOR_ID : LAP_DETECTOR_AC_EVO_ID,
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
      const stage = failure === "lmu" ? "LMU session identity backfill" : "Race-result backfill";
      await backend.waitFor(`[StartupWorker] ${stage} failed: Startup reconciliation incomplete:`);
      await backend.stop();
      expect(backend.output()).toContain(COMPLETE);
      if (failure === "lmu") {
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
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
}
