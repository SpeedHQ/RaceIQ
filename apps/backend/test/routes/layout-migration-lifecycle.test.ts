import { expect, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import {
  drainLayoutMigration,
  getLayoutMigrationStatus,
  startLayoutMigration,
  stopLayoutMigrationAdmission,
} from "@raceiq/backend-core/session-capture/layout-migration";
import {
  beginRecordingStorageImport,
  getRecordingStorageActivity,
} from "@raceiq/backend-core/session-capture/storage-activity";
import { registerActiveSessionQuery } from "@raceiq/backend-core/session-capture/session-activity";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";

// Shutdown admission is process-wide and irreversible. Each case owns its runtime and database.
function test(name: string, scenario: () => Promise<void>) {
  if (process.env.RACEIQ_LAYOUT_LIFECYCLE_CASE) {
    if (process.env.RACEIQ_LAYOUT_LIFECYCLE_CASE === name) bunTest(name, scenario, 10000);
    return;
  }
  bunTest(name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "raceiq-layout-lifecycle-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          ...process.env,
          DATA_DIR: directory,
          RACEIQ_TEST_DATA_DIR: directory,
          RACEIQ_TEST_MODE: "1",
          RACEIQ_LAYOUT_LIFECYCLE_CASE: name,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = setTimeout(() => child.kill(), 15000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`Migration lifecycle scenario failed (${code}):\n${stdout}\n${stderr}`);
      } finally {
        clearTimeout(deadline);
        child.kill();
        await child.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20000);
}

async function fixture() {
  initGameAdapters();
  registerActiveSessionQuery(() => false);
  const root = join(resolveDataDir(), "recordings");
  const source = join(root, "fm-2023", "waiting.bin");
  const destination = join(root, "fm-2023", "own", "waiting.bin");
  await mkdir(join(root, "fm-2023"), { recursive: true });
  await writeFile(source, "preserve until migration owns idle storage");
  saveSettings({ ...loadSettings(), recordingDirectory: root });
  return { source, destination, journal: join(resolveDataDir(), "recording-layout-migration.json") };
}

async function waitForPhase(phase: "waiting-for-session" | "organizing") {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const { progress } = await getLayoutMigrationStatus();
    if (progress.status === "running" && progress.phase === phase) return;
    await delay(1);
  }
  throw new Error(`Migration did not enter ${phase}`);
}

async function waitForReservation() {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (getRecordingStorageActivity().relocating) return;
    await delay(1);
  }
  throw new Error("Migration did not reserve storage");
}

async function expectUnchanged(paths: { source: string; destination: string; journal: string }) {
  expect(await readFile(paths.source, "utf8")).toBe("preserve until migration owns idle storage");
  expect(await Bun.file(paths.destination).exists()).toBe(false);
  expect(await Bun.file(paths.journal).exists()).toBe(false);
}

function startObserved() {
  return startLayoutMigration().then(() => ({ error: null }), (error: unknown) => ({ error }));
}

test("shutdown cancels and drains a pending storage reservation before imports finish", async () => {
  const paths = await fixture();
  const releaseImport = beginRecordingStorageImport();
  try {
    const migration = startObserved();
    await waitForPhase("organizing");
    await expect(startLayoutMigration()).rejects.toMatchObject({ code: "MIGRATION_ACTIVE" });
    let drained = false;
    const drain = drainLayoutMigration().then(() => { drained = true; });
    await delay(1);
    expect(drained).toBe(false);

    stopLayoutMigrationAdmission();
    expect((await migration).error).toMatchObject({ code: "MIGRATION_STOPPING" });
    await drain;
    expect(getRecordingStorageActivity()).toEqual({ imports: 1, relocating: false });
    await expectUnchanged(paths);
    await expect(startLayoutMigration()).rejects.toMatchObject({ code: "MIGRATION_STOPPING" });

    releaseImport();
    await delay(1);
    expect(getRecordingStorageActivity()).toEqual({ imports: 0, relocating: false });
    await expectUnchanged(paths);
  } finally {
    releaseImport();
  }
});

test("shutdown cancels session waiting without waiting for recorder shutdown", async () => {
  const paths = await fixture();
  registerActiveSessionQuery(() => true);
  const migration = startObserved();
  await waitForPhase("waiting-for-session");
  await waitForReservation();
  stopLayoutMigrationAdmission();
  expect((await migration).error).toMatchObject({ code: "MIGRATION_STOPPING" });
  await drainLayoutMigration();
  expect(getRecordingStorageActivity()).toEqual({ imports: 0, relocating: false });
  await expectUnchanged(paths);
  await expect(startLayoutMigration()).rejects.toMatchObject({ code: "MIGRATION_STOPPING" });
});

test("shutdown drains a queued maintenance lock and prevents migration after unlock", async () => {
  const paths = await fixture();
  let started = false;
  const idleCheck = Promise.withResolvers<void>();
  registerActiveSessionQuery(() => {
    if (started) idleCheck.resolve();
    return false;
  });
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const lock = withSessionCaptureMaintenanceLock(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const migration = startObserved();
  started = true;
  let drain: Promise<void> | undefined;
  try {
    await idleCheck.promise;
    stopLayoutMigrationAdmission();
    let drained = false;
    drain = drainLayoutMigration().then(() => { drained = true; });
    await delay(1);
    expect(drained).toBe(false);
    await expectUnchanged(paths);
  } finally {
    gate.resolve();
    await lock;
  }
  expect((await migration).error).toMatchObject({ code: "MIGRATION_STOPPING" });
  await drain;
  expect(getRecordingStorageActivity()).toEqual({ imports: 0, relocating: false });
  await expectUnchanged(paths);
});

test("session activation while acquiring maintenance lock defers migration until recorder drains", async () => {
  const paths = await fixture();
  let recording = false;
  let started = false;
  const idleCheck = Promise.withResolvers<void>();
  registerActiveSessionQuery(() => {
    if (started && !recording) idleCheck.resolve();
    return recording;
  });
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const lock = withSessionCaptureMaintenanceLock(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const migration = startObserved();
  started = true;
  try {
    // The asynchronous idle check queues behind the lock before recorder activation.
    await idleCheck.promise;
    recording = true;
  } finally {
    gate.resolve();
    await lock;
  }
  await waitForPhase("waiting-for-session");
  await expectUnchanged(paths);
  expect(getRecordingStorageActivity()).toEqual({ imports: 0, relocating: true });
  recording = false;
  expect((await migration).error).toBeNull();
  await drainLayoutMigration();
  expect((await getLayoutMigrationStatus()).progress.status).toBe("success");
  expect(await readFile(paths.destination, "utf8")).toBe("preserve until migration owns idle storage");
  expect(await Bun.file(paths.source).exists()).toBe(false);
  expect(await Bun.file(paths.journal).exists()).toBe(false);
  expect(getRecordingStorageActivity()).toEqual({ imports: 0, relocating: false });
});
