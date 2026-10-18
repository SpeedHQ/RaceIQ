import { expect, test } from "bun:test";
import Database from "libsql";
import { LAP_DETECTOR_AC_EVO_ID } from "@raceiq/game-ac-evo/lap-detector";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { decompressIfGzipSync, iterateSessionCaptureRecords, SESSION_SEGMENT_BOUNDARY, SESSION_SEGMENT_CONTEXT, SESSION_SEGMENT_CONTEXT_END } from "@raceiq/capture-formats/session/framing";
import { seedReleaseDatabase } from "./support/release-database";
const ROOT = resolve(import.meta.dir, "../../../..");
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
