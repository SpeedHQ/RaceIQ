import { afterEach, expect, test } from "bun:test";
import Database from "libsql";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import { LAP_DETECTOR_AC_EVO_ID } from "@raceiq/game-ac-evo/lap-detector";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { decompressIfGzipSync, iterateSessionCaptureRecords, SESSION_SEGMENT_BOUNDARY, SESSION_SEGMENT_CONTEXT, SESSION_SEGMENT_CONTEXT_END } from "@raceiq/capture-formats/session/framing";

const ROOT = resolve(import.meta.dir, "../../../..");
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
  organize(): Promise<"success" | "failed">;
  output(): string;
  stop(): Promise<void>;
}

function environment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, NODE_ENV: "production", RACEIQ_DISABLE_TRAY: "1" };
  delete env.RACEIQ_TEST_MODE;
  delete env.DB_IN_MEMORY;
  delete env.RACEIQ_TEST_DATA_DIR;
  delete env.PW_SEED_SCREENSHOTS;
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
    // This test-only request waits for migration/replay, which can exceed Bun's
    // default HTTP idle timeout while the backend is still working normally.
    const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      try {
        await startLayoutMigration();
        while (true) {
          const status = await getLayoutMigrationStatus();
          if (status.progress.status === "success") {
            console.log("[E2E] Layout migration success");
            return Response.json({ status: "success" });
          }
          if (status.progress.status === "partial" || status.progress.status === "error") {
            console.log("[E2E] Layout migration failed");
            return Response.json({ status: "failed" });
          }
          await Bun.sleep(10);
        }
      } catch (error) {
        console.error("[E2E] Layout migration failed", error);
        return new Response(null, { status: 500 });
      }
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
      const response = await fetch(`http://127.0.0.1:${match[1]}`, { method: "POST" });
      if (!response.ok) throw new Error(`Migration control returned ${response.status}`);
      const result = await response.json() as { status?: unknown };
      if (result.status !== "success" && result.status !== "failed") throw new Error("Migration control returned an invalid result");
      return result.status;
    },
    output: () => output,
    async stop() {
      if (!exited) proc.kill("SIGTERM");
      await proc.exited;
      await drained;
    },
  };
}

test("current startup reprocesses release-seeded Tourist sessions into correct lap results", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-release-upgrade-"));
  const releaseDir = join(temporary, "release");
  const dataDir = join(temporary, "data");
  mkdirSync(releaseDir);
  mkdirSync(dataDir);
  let backend: StartupBackend | undefined;
  let database: InstanceType<typeof Database> | undefined;
  try {
    const tags = (await command(["git", "tag", "--sort=-version:refname"])).trim().split(/\r?\n/);
    const tag = tags.find((value) => /^v\d+\.\d+\.\d+$/.test(value));
    if (!tag) throw new Error("No stable release tag available; fetch release tags before running database-upgrade.test.ts.");
    console.log(`[Upgrade] Baseline ${tag} -> current working branch`);
    const archive = join(temporary, "release.tar");
    await command(["git", "archive", "--format=tar", `--output=${archive}`, tag]);
    await command(["tar", "-xf", archive, "-C", releaseDir, "--exclude=.claude"]);
    // Release postinstall installs Git hooks and requires a repository.
    await command(["git", "init", "--quiet"], releaseDir);
    // Release dependencies must not resolve into current workspace code.
    await command([process.execPath, "install", "--frozen-lockfile"], releaseDir);
    const fixture = join(temporary, "ac-evo-tourist.bin.gz");
    writeFileSync(fixture, Buffer.concat([1, 2].map((part) =>
      readFileSync(join(ROOT, `test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part${part}`)),
    )));
    await command([process.execPath, "run", "db:seed", "--games=ac-evo", `--fixtures=${fixture}`], releaseDir, environment(dataDir));
    // The old release is no longer needed after seeding. Its dependency tree
    // can take longer than a teardown hook permits to remove on Windows; do
    // that work within this test's explicit upgrade timeout instead.
    const cleanupStarted = performance.now();
    console.log("[Upgrade] Removing old release dependencies");
    await rm(releaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(archive, { force: true });
    console.log(`[Upgrade] Old release removed in ${Math.round(performance.now() - cleanupStarted)}ms`);
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const before = database.prepare("SELECT id,lap_detector_version FROM sessions ORDER BY id").all() as Array<{ id: number; lap_detector_version: string | null }>;
    expect(before.every((session) => session.lap_detector_version !== null)).toBe(true);
    // Deliberately stale results distinguish replay from a marker-only migration.
    database.exec("UPDATE laps SET lap_time=999; UPDATE sessions SET track_id='obsolete layout';");

    const firstRecording = database.prepare("SELECT raw_file, ownership FROM sessions ORDER BY id LIMIT 1").get() as { raw_file: string; ownership: string };
    // Full-frame conversion is a prerequisite to this upgrade, separate from folder organization.
    const converted = await convertSeedFramesToSparse("ac-evo", (function* () {
      for (const record of iterateSessionCaptureRecords(decompressIfGzipSync(Buffer.from(readFileSync(fixture))))) {
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
    await backend.ready();
    const after = database.prepare("SELECT id,track_id,lap_detector_version,raw_file,ownership FROM sessions ORDER BY id").all() as Session[];
    expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id));
    for (const session of after) {
      expect(session.track_id).toBe('["Nurburgring","Touristenfahrten"]');
      expect(session.raw_file).toBe(join(gameDirectory, session.ownership === "others" ? "others" : "own", basename(legacyPath)));
    }
    const finishes = database.prepare("SELECT lap_time FROM laps WHERE is_valid=1 AND invalid_reason IS NULL ORDER BY lap_time").all() as Array<{ lap_time: number }>;
    expect(finishes.map((lap) => lap.lap_time)).toEqual([398.781, 401.277]);
    expect(database.prepare("SELECT id FROM laps WHERE lap_time=999").all()).toEqual([]);
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
    // Simulate an installation that already completed historical reconciliation
    // before the Tourist identity migration (renumbered to v78).
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
    const after = database.prepare("SELECT id,track_id,lap_detector_version FROM sessions ORDER BY id").all() as Session[];
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
    database = undefined;
    temporaryDirectories.push(temporary);
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
      database = undefined;
      temporaryDirectories.push(temporary);
    }
  }, 60_000);
}
