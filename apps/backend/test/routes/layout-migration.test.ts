import { afterEach, describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { miscRoutes } from "../../src/routes/system/index";
import { startRecordingDirectoryMove, getRecordingDirectoryMoveStatus } from "../../src/session-capture/relocate-recordings";
import { isLayoutMigrationReadyForStartup } from "../../src/session-capture/layout-migration";
import { beginRecordingStorageImport } from "@raceiq/backend-core/session-capture/storage-activity";
import { withSessionCaptureMaintenanceLock, cleanupOrphanSessionFiles } from "@raceiq/backend-core/session-capture/cleanup";

initGameAdapters();
const inserted: number[] = [];
const temporary: string[] = [];
const originalSettings = loadSettings();
afterEach(async () => {
  for (const id of inserted.splice(0)) await db.delete(sessions).where(eq(sessions.id, id)).run();
  saveSettings(originalSettings);
  await rm(join(resolveDataDir(), "recording-layout-migration.json"), { force: true });
  await rm(join(resolveDataDir(), "recording-directory-move.json"), { force: true });
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function addSession(rawFile: string, ownership: "mine" | "others"): Promise<number> {
  const row = await db.insert(sessions).values({ gameId: "fm-2023", carId: "layout-test", trackId: "layout-test", rawFile, ownership }).returning({ id: sessions.id }).get();
  inserted.push(row.id);
  return row.id;
}
async function waitForMigration(): Promise<{ status: string; done: number; total: number }> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const response = await miscRoutes.request("/api/storage/layout-migration");
    const body = await response.json() as { progress: { status: string; done: number; total: number } };
    if (body.progress.status === "success" || body.progress.status === "partial" || body.progress.status === "error") return body.progress;
  }
  throw new Error("Layout migration did not finish");
}
async function startMigration(directory?: string) {
  return miscRoutes.request("/api/storage/layout-migration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(directory === undefined ? {} : { directory }) });
}

describe("recording layout migration", () => {
  test("detects default-root legacy files without changing them", async () => {
    const root = resolveRecordingDirectory();
    const source = join(root, "fm-2023", `layout-detect-${Date.now()}.bin`);
    temporary.push(source);
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await writeFile(source, "legacy recording");
    const response = await miscRoutes.request("/api/storage/layout-migration");
    const body = await response.json() as { fileCount: number };
    expect(body.fileCount).toBeGreaterThan(0);
    expect(await readFile(source, "utf8")).toBe("legacy recording");
    expect(await isLayoutMigrationReadyForStartup()).toBe(false);
  });

  test("routes mixed-ownership references under a custom root on explicit consent", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-migration-"));
    temporary.push(root);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "shared.bin.gz");
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await writeFile(source, "shared legacy capture");
    const mine = await addSession(source, "mine");
    const other = await addSession(source, "others");
    const before = await miscRoutes.request("/api/storage/layout-migration");
    expect((await before.json() as { fileCount: number; sessionCount: number })).toMatchObject({ fileCount: 1, sessionCount: 2 });
    expect(await readFile(source, "utf8")).toBe("shared legacy capture");

    const started = await startMigration();
    expect(started.status).toBe(202);
    expect((await waitForMigration()).status).toBe("success");
    const minePath = join(root, "fm-2023", "own", "shared.bin.gz");
    const otherPath = join(root, "fm-2023", "others", "shared.bin.gz");
    expect(await readFile(minePath, "utf8")).toBe("shared legacy capture");
    expect(await readFile(otherPath, "utf8")).toBe("shared legacy capture");
    expect(await Bun.file(source).exists()).toBe(false);
    const rows = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, mine)).all();
    expect(rows[0]?.rawFile).toBe(minePath);
    const otherRows = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, other)).all();
    expect(otherRows[0]?.rawFile).toBe(otherPath);
    const completed = await miscRoutes.request("/api/storage/layout-migration");
    expect(await completed.json()).toMatchObject({ fileCount: 0 });
    expect(await isLayoutMigrationReadyForStartup()).toBe(true);
    const movedRoot = await mkdtemp(join(tmpdir(), "raceiq-layout-moved-"));
    temporary.push(movedRoot);
    const move = await startRecordingDirectoryMove(movedRoot);
    expect(move.noOp).not.toBe(true);
    // The move runs against real filesystem I/O; fake timers cannot advance it.
    for (let attempt = 0; attempt < 200 && getRecordingDirectoryMoveStatus().state === "moving"; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(getRecordingDirectoryMoveStatus().state).toBe("complete");
  });

  test("organizes legacy captures then relocates root to selected destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-source-"));
    const destination = join(root, "raceiq");
    temporary.push(root, destination);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "selected.bin");
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await writeFile(source, "selected capture");
    const response = await startMigration(destination);
    expect(response.status).toBe(202);
    expect((await waitForMigration()).status).toBe("success");
    expect(resolveRecordingDirectory()).toBe(await realpath(destination));
    expect(await readFile(join(destination, "fm-2023", "own", "selected.bin"), "utf8")).toBe("selected capture");
  });

  test("migrates into an occupied destination and preserves unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-invalid-source-"));
    const destination = await mkdtemp(join(tmpdir(), "raceiq-layout-invalid-target-"));
    temporary.push(root, destination);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "unchanged.bin");
    const organized = join(destination, "fm-2023", "own", "unchanged.bin");
    const preserved = Buffer.from([0, 1, 255, 4]);
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await writeFile(source, "keep source");
    await writeFile(join(destination, "unrelated.txt"), preserved);
    expect((await startMigration(destination)).status).toBe(202);
    expect((await waitForMigration()).status).toBe("success");
    expect(resolveRecordingDirectory()).toBe(await realpath(destination));
    expect(await readFile(organized, "utf8")).toBe("keep source");
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await readFile(join(destination, "unrelated.txt"))).toEqual(preserved);
  });

  test.each(["before-commit", "after-commit"] as const)("resumes chosen-root migration %s after legacy files are already organized", async (phase) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "raceiq-layout-chosen-recovery-source-")));
    const destination = await realpath(await mkdtemp(join(tmpdir(), "raceiq-layout-chosen-recovery-target-")));
    temporary.push(root, destination);
    const name = phase === "after-commit" ? "recording.capture" : "recording.bin";
    const legacy = join(root, "fm-2023", name);
    const organized = join(root, "fm-2023", "own", name);
    const relocated = join(destination, "fm-2023", "own", name);
    const bytes = Buffer.from("recover chosen location without losing data");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(root, "fm-2023", "own"), { recursive: true });
    await mkdir(join(destination, "fm-2023", "own"), { recursive: true });
    await writeFile(organized, bytes);
    await writeFile(relocated, bytes);
    const sessionId = await addSession(relocated, "mine");
    await db.update(sessions).set({ notes: "preserved note", isFavorite: true }).where(eq(sessions.id, sessionId)).run();
    saveSettings({ ...loadSettings(), recordingDirectory: phase === "after-commit" ? destination : root });
    await writeFile(join(resolveDataDir(), "recording-layout-migration.json"), JSON.stringify({
      version: 1, root, destination, phase: "relocating",
      entries: [{ source: legacy, digest, destinations: [organized], published: [organized], references: [{ sessionId, oldPath: legacy, newPath: organized }], cutover: true }],
      progress: { status: "running", phase: "relocating", done: 1, total: 1, migrated: 1, failed: 0, error: null },
    }));
    await writeFile(join(resolveDataDir(), "recording-directory-move.json"), JSON.stringify({
      version: 1, operationId: "11111111-1111-4111-8111-111111111111", oldDirectory: root, newDirectory: destination, oldSetting: root,
      entries: [{ source: organized, destination: relocated, size: bytes.length, sha256: digest }],
      references: [{ sessionId, oldPath: organized, newPath: relocated }],
    }));
    const detected = await miscRoutes.request("/api/storage/layout-migration");
    expect(await detected.json()).toMatchObject({ destinationDirectory: destination, fileCount: 0, progress: { status: "error", phase: "relocating" } });
    expect(await readFile(organized)).toEqual(bytes);
    expect(await readFile(relocated)).toEqual(bytes);
    expect((await startMigration(join(root, "wrong-target"))).status).toBe(409);
    expect(await readFile(organized)).toEqual(bytes);
    expect((await startMigration(destination)).status).toBe(202);
    expect(await waitForMigration()).toMatchObject({ status: "success" });
    expect(resolveRecordingDirectory()).toBe(destination);
    expect(await readFile(relocated)).toEqual(bytes);
    expect(await Bun.file(organized).exists()).toBe(false);
    const row = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row).toMatchObject({ rawFile: relocated, notes: "preserved note", isFavorite: true });
    expect(await Bun.file(join(resolveDataDir(), "recording-layout-migration.json")).exists()).toBe(false);
    expect(await Bun.file(join(resolveDataDir(), "recording-directory-move.json")).exists()).toBe(false);
  });

  test("preserves source on collision then retries after conflict removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-retry-"));
    temporary.push(root);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "collision.bin");
    const ownDestination = join(root, "fm-2023", "own", "collision.bin");
    const otherDestination = join(root, "fm-2023", "others", "collision.bin");
    const unrelated = join(root, "fm-2023", "notes.txt");
    await mkdir(join(root, "fm-2023", "own"), { recursive: true });
    await mkdir(join(root, "fm-2023", "others"), { recursive: true });
    await writeFile(source, "original capture");
    await writeFile(otherDestination, "pre-existing data");
    await writeFile(unrelated, "unrelated");
    await addSession(source, "mine");
    await addSession(source, "others");
    expect((await startMigration()).status).toBe(202);
    expect((await waitForMigration()).status).toBe("partial");
    expect(await readFile(source, "utf8")).toBe("original capture");
    expect(await readFile(ownDestination, "utf8")).toBe("original capture");
    expect(await readFile(otherDestination, "utf8")).toBe("pre-existing data");
    expect(await cleanupOrphanSessionFiles()).toBe(0);
    expect(await readFile(ownDestination, "utf8")).toBe("original capture");

    await rm(otherDestination);
    expect((await startMigration()).status).toBe(202);
    expect((await waitForMigration()).status).toBe("success");
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await readFile(ownDestination, "utf8")).toBe("original capture");
    expect(await readFile(otherDestination, "utf8")).toBe("original capture");
    expect(await readFile(unrelated, "utf8")).toBe("unrelated");
  });

  test("detects referenced nonstandard capture files but ignores unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-reference-"));
    temporary.push(root);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const game = join(root, "fm-2023");
    const source = join(game, "capture.custom");
    const unrelated = join(game, "notes.txt");
    await mkdir(game, { recursive: true });
    await writeFile(source, "referenced");
    await writeFile(unrelated, "unrelated");
    await addSession(source, "mine");
    const response = await miscRoutes.request("/api/storage/layout-migration");
    expect((await response.json() as { fileCount: number; sessionCount: number })).toMatchObject({ fileCount: 1, sessionCount: 1 });
    expect(await isLayoutMigrationReadyForStartup()).toBe(false);
    expect(await readFile(source, "utf8")).toBe("referenced");
    expect(await readFile(unrelated, "utf8")).toBe("unrelated");
  });
  test("resumes a published cutover after source removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-recovery-"));
    temporary.push(root);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "recovered.bin");
    const destination = join(root, "fm-2023", "own", "recovered.bin");
    const payload = "published capture";
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await mkdir(join(root, "fm-2023", "own"), { recursive: true });
    await writeFile(destination, payload);
    const sessionId = await addSession(destination, "mine");
    const digest = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(resolveDataDir(), "recording-layout-migration.json"), JSON.stringify({
      version: 1, root, destination: root, phase: "organizing", entries: [{ source, digest, destinations: [destination], published: [destination], references: [{ sessionId, oldPath: source, newPath: destination }], cutover: false }],
      progress: { status: "running", done: 0, total: 1, migrated: 0, failed: 0, error: null },
    }));
    expect(await isLayoutMigrationReadyForStartup()).toBe(false);
    expect((await startMigration()).status).toBe(202);
    expect((await waitForMigration()).status).toBe("success");
    expect(await isLayoutMigrationReadyForStartup()).toBe(true);
    expect(await readFile(destination, "utf8")).toBe(payload);
    expect(await Bun.file(join(resolveDataDir(), "recording-layout-migration.json")).exists()).toBe(false);
  });

  test("preserves source when a published destination was tampered with", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-tamper-"));
    temporary.push(root);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "tampered.bin");
    const destination = join(root, "fm-2023", "own", "tampered.bin");
    const payload = "original capture";
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await mkdir(join(root, "fm-2023", "own"), { recursive: true });
    await writeFile(source, payload);
    await writeFile(destination, "tampered");
    const sessionId = await addSession(source, "mine");
    const digest = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(resolveDataDir(), "recording-layout-migration.json"), JSON.stringify({
      version: 1, root, destination: root, phase: "organizing", entries: [{ source, digest, destinations: [destination], published: [destination], references: [{ sessionId, oldPath: source, newPath: destination }], cutover: false }],
      progress: { status: "running", done: 0, total: 1, migrated: 0, failed: 0, error: null },
    }));
    expect((await startMigration()).status).toBe(202);
    expect((await waitForMigration()).status).toBe("partial");
    expect(await readFile(source, "utf8")).toBe(payload);
    expect(await readFile(destination, "utf8")).toBe("tampered");
  });
  test("rejects imports and moves while migration operation is reserved", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-reservation-"));
    const movedRoot = await mkdtemp(join(tmpdir(), "raceiq-layout-reservation-move-"));
    temporary.push(root, movedRoot);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", "reserved.bin");
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await writeFile(source, "legacy");

    const releaseImport = beginRecordingStorageImport();
    try {
      const busy = await startMigration();
      expect(busy.status).toBe(409);
    } finally { releaseImport(); }

    let unlock!: () => void;
    const lock = withSessionCaptureMaintenanceLock(() => new Promise<void>((resolve) => { unlock = resolve; }));
    await Promise.resolve();
    const migration = startMigration();
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await miscRoutes.request("/api/storage/layout-migration");
      const state = await response.json() as { progress: { status: string } };
      if (state.progress.status === "running") break;
    }
    try {
      await expect(startRecordingDirectoryMove(movedRoot)).rejects.toMatchObject({ code: "MOVE_ACTIVE" });
    } finally {
      unlock();
      await lock;
    }
    expect((await migration).status).toBe(202);
    expect((await waitForMigration()).status).toBe("success");
  });
  test("rejects a symlinked migration journal without reading its external target", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-journal-root-"));
    const external = await mkdtemp(join(tmpdir(), "raceiq-layout-journal-external-"));
    temporary.push(root, external);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const target = join(external, "outside.json");
    const journalPath = join(resolveDataDir(), "recording-layout-migration.json");
    const contents = JSON.stringify({ outside: true });
    await writeFile(target, contents);
    await symlink(target, journalPath);
    const response = await miscRoutes.request("/api/storage/layout-migration");
    expect((await response.json() as { progress: { status: string; error: string | null } }).progress).toMatchObject({ status: "error" });
    expect(await readFile(target, "utf8")).toBe(contents);
  });
  test.each(["missing-destination", "unrelated-file"] as const)("rejects unsafe %s journal without removing the source", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-layout-unsafe-journal-"));
    temporary.push(root);
    saveSettings({ ...loadSettings(), recordingDirectory: root });
    const source = join(root, "fm-2023", scenario === "unrelated-file" ? "notes.txt" : "capture.bin");
    const destination = join(root, "fm-2023", "own", basename(source));
    await mkdir(join(root, "fm-2023"), { recursive: true });
    const bytes = Buffer.from("must remain untouched");
    await writeFile(source, bytes);
    await writeFile(join(resolveDataDir(), "recording-layout-migration.json"), JSON.stringify({
      version: 1, root, destination: root, phase: "organizing",
      entries: [{ source, digest: createHash("sha256").update(bytes).digest("hex"), destinations: scenario === "missing-destination" ? [] : [destination], published: [], references: [], cutover: false }],
      progress: { status: "running", done: 0, total: 1, migrated: 0, failed: 0, error: null },
    }));
    const detected = await miscRoutes.request("/api/storage/layout-migration");
    expect(await detected.json()).toMatchObject({ progress: { status: "error" } });
    expect((await startMigration()).status).toBe(500);
    expect(await waitForMigration()).toMatchObject({ status: "error" });
    expect(await readFile(source)).toEqual(bytes);
    expect(await Bun.file(destination).exists()).toBe(false);
  });
});
