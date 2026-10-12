import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile as fsCopyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, unlink as fsUnlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { insertSession, deleteSession } from "@raceiq/backend-core/db/session-queries";
import { sessions } from "@raceiq/backend-core/db/schema";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { beginRecordingStorageImport } from "@raceiq/backend-core/session-capture/storage-activity";
import { startRecordingDirectoryMove, getRecordingDirectoryMoveStatus, recoverRecordingDirectoryMove } from "@raceiq/backend-core/session-capture/relocate-recordings";

async function waitForMove(): Promise<void> {
  // The move runs on real filesystem I/O in a detached background task; fake timers cannot advance that work.
  for (let attempt = 0; attempt < 200 && getRecordingDirectoryMoveStatus().state === "moving"; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(getRecordingDirectoryMoveStatus().state).toBe("complete");
}
async function waitForMoveError(code: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && getRecordingDirectoryMoveStatus().state === "moving"; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(getRecordingDirectoryMoveStatus()).toMatchObject({ state: "error", code });
}
describe("recording-directory relocation", () => {
  const originalDirectory = loadSettings().recordingDirectory;
  let sandbox: string | undefined;

  afterAll(async () => {
    if (originalDirectory !== undefined) saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory });
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  });

  test("rejects a nonempty destination without changing source or selected directory", async () => {
    sandbox = await mkdtemp(join(tmpdir(), "raceiq-recording-move-"));
    const source = join(sandbox, "occupied-source");
    const destination = join(sandbox, "occupied-destination");
    const capture = join(source, "test-game", "capture.bin");
    const unrelated = join(destination, "keep.txt");
    const bytes = Buffer.from("source remains available");
    await mkdir(join(source, "test-game"), { recursive: true });
    await mkdir(destination);
    await writeFile(capture, bytes);
    await writeFile(unrelated, "unrelated destination data");
    saveSettings({ ...loadSettings(), recordingDirectory: source });

    await expect(startRecordingDirectoryMove(destination)).rejects.toMatchObject({ code: "DESTINATION_NOT_EMPTY" });
    expect(loadSettings().recordingDirectory).toBe(source);
    expect(await readFile(capture)).toEqual(bytes);
    expect(await readFile(unrelated, "utf8")).toBe("unrelated destination data");
  });

  test("selecting current canonical root is a no-op", async () => {
    const source = join(sandbox!, "same-root");
    const capture = join(source, "test-game", "capture.bin");
    const bytes = Buffer.from("same-root capture");
    await mkdir(join(source, "test-game"), { recursive: true });
    await writeFile(capture, bytes);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    const canonicalSource = await realpath(source);

    const result = await startRecordingDirectoryMove(canonicalSource);

    expect(result).toEqual({ operationId: "", noOp: true });
    expect(loadSettings().recordingDirectory).toBe(source);
    expect(getRecordingDirectoryMoveStatus().state).not.toBe("moving");
    expect(await readFile(capture)).toEqual(bytes);
  });

  test("copies capture bytes, commits selected directory, then removes source", async () => {
    const source = join(sandbox!, "old");
    const destination = join(sandbox!, "new");
    const captureDir = join(source, "test-game");
    const capture = join(captureDir, "capture.bin");
    const bytes = Buffer.from("recording relocation integration fixture");
    await mkdir(captureDir, { recursive: true });
    await writeFile(capture, bytes);
    saveSettings({ ...loadSettings(), recordingDirectory: source });

    const { operationId, noOp } = await startRecordingDirectoryMove(destination);
    expect(noOp).toBeUndefined();
    expect(operationId).toBeTruthy();
    // The operation runs on the real filesystem; poll its observable status rather than mocking copy completion.
    for (let attempt = 0; attempt < 200 && getRecordingDirectoryMoveStatus().state === "moving"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getRecordingDirectoryMoveStatus().state).toBe("complete");
    expect(loadSettings().recordingDirectory).toBe(await realpath(destination));
    expect(await readFile(join(destination, "test-game", "capture.bin"))).toEqual(bytes);
    await expect(readFile(capture)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("rebases shared DB references, preserves metadata, leaves missing and external references correctly scoped", async () => {
    const source = join(sandbox!, "references-old");
    const destination = join(sandbox!, "references-new");
    const capture = join(source, "test-game", "shared.bin");
    const missing = join(source, "test-game", "missing.bin");
    const external = join(sandbox!, "external", "capture.bin");
    const unrelated = join(source, "notes.txt");
    const bytes = Buffer.from("shared raw capture bytes");
    const sessionIds: number[] = [];
    await mkdir(join(source, "test-game"), { recursive: true });
    await mkdir(join(sandbox!, "external"));
    await writeFile(capture, bytes);
    await writeFile(external, "external capture");
    await writeFile(unrelated, "unrelated source content");
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    try {
      const first = await insertSession("car-a", "track-a", "fm-2023", "race");
      const second = await insertSession("car-b", "track-b", "fm-2023", "practice");
      const missingId = await insertSession("car-c", "track-c", "fm-2023");
      const externalId = await insertSession("car-d", "track-d", "fm-2023");
      sessionIds.push(first, second, missingId, externalId);
      await db.update(sessions).set({ rawFile: capture, notes: "first metadata", isFavorite: true, lapDetectorVersion: "detector-a" }).where(eq(sessions.id, first)).run();
      await db.update(sessions).set({ rawFile: capture, notes: "second metadata", isFavorite: false, lapDetectorVersion: "detector-b" }).where(eq(sessions.id, second)).run();
      await db.update(sessions).set({ rawFile: missing }).where(eq(sessions.id, missingId)).run();
      await db.update(sessions).set({ rawFile: external }).where(eq(sessions.id, externalId)).run();
      const before = await db.select().from(sessions).where(eq(sessions.id, first)).get();

      await startRecordingDirectoryMove(destination);
      await waitForMove();

      const after = await db.select().from(sessions).where(eq(sessions.id, first)).get();
      const secondAfter = await db.select().from(sessions).where(eq(sessions.id, second)).get();
      const missingAfter = await db.select().from(sessions).where(eq(sessions.id, missingId)).get();
      const externalAfter = await db.select().from(sessions).where(eq(sessions.id, externalId)).get();
      const destinationCapture = join(await realpath(destination), "test-game", "shared.bin");
      expect(await readFile(destinationCapture)).toEqual(bytes);
      expect(after).toMatchObject({ rawFile: destinationCapture, notes: before!.notes, isFavorite: before!.isFavorite, lapDetectorVersion: before!.lapDetectorVersion, carId: before!.carId, trackId: before!.trackId, gameId: before!.gameId });
      expect(secondAfter?.rawFile).toBe(destinationCapture);
      expect(secondAfter).toMatchObject({ notes: "second metadata", isFavorite: false, lapDetectorVersion: "detector-b" });
      expect(missingAfter?.rawFile).toBe(join(await realpath(destination), "test-game", "missing.bin"));
      await expect(readFile(missingAfter!.rawFile!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(externalAfter?.rawFile).toBe(external);
      await expect(readFile(capture)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(unrelated, "utf8")).toBe("unrelated source content");
    } finally {
      for (const id of sessionIds) await deleteSession(id);
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
    }
  });
  test("does not rebase or copy DB references through file or directory symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-recording-symlink-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    const gameDirectory = join(source, "test-game");
    const externalDirectory = join(root, "external");
    const externalFile = join(externalDirectory, "capture.bin");
    const fileLink = join(gameDirectory, "file-link.bin");
    const directoryLink = join(gameDirectory, "directory-link");
    const externalCapture = join(externalDirectory, "nested", "capture.bin");
    const bytes = Buffer.from("external symlink target");
    const sessionIds: number[] = [];
    await mkdir(gameDirectory, { recursive: true });
    await mkdir(join(externalDirectory, "nested"), { recursive: true });
    await writeFile(externalFile, bytes);
    await writeFile(externalCapture, bytes);
    await symlink(externalFile, fileLink);
    await symlink(externalDirectory, directoryLink);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    try {
      const fileSessionId = await insertSession("symlink-file-car", "track", "fm-2023");
      const directorySessionId = await insertSession("symlink-dir-car", "track", "fm-2023");
      sessionIds.push(fileSessionId, directorySessionId);
      await db.update(sessions).set({ rawFile: fileLink }).where(eq(sessions.id, fileSessionId)).run();
      await db.update(sessions).set({ rawFile: join(directoryLink, "nested", "capture.bin") }).where(eq(sessions.id, directorySessionId)).run();

      await startRecordingDirectoryMove(destination);
      await waitForMove();

      const fileSession = await db.select().from(sessions).where(eq(sessions.id, fileSessionId)).get();
      const directorySession = await db.select().from(sessions).where(eq(sessions.id, directorySessionId)).get();
      expect(fileSession?.rawFile).toBe(fileLink);
      expect(directorySession?.rawFile).toBe(join(directoryLink, "nested", "capture.bin"));
      expect(await readFile(fileLink)).toEqual(bytes);
      expect(await readFile(join(directoryLink, "nested", "capture.bin"))).toEqual(bytes);
      await expect(readFile(join(destination, "test-game", "file-link.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(destination, "test-game", "directory-link", "nested", "capture.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const id of sessionIds) await deleteSession(id);
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
      await rm(root, { recursive: true, force: true });
    }
  });
  test("rebases database references through the macOS /var alias", async () => {
    const canonicalBase = await realpath(tmpdir());
    if (!canonicalBase.startsWith("/private/var/")) return;
    const lexicalBase = canonicalBase.replace(/^\/private\/var\//, "/var/");
    if (await realpath(lexicalBase).catch(() => "") !== canonicalBase) return;

    const source = join(canonicalBase, "raceiq-alias-source");
    const sourceAlias = join(lexicalBase, "raceiq-alias-source");
    const destination = join(canonicalBase, "raceiq-alias-destination");
    const capture = join(sourceAlias, "test-game", "capture.bin");
    const bytes = Buffer.from("capture through lexical alias");
    let sessionId: number | undefined;
    let canonicalSessionId: number | undefined;
    await mkdir(join(source, "test-game"), { recursive: true });
    await writeFile(join(source, "test-game", "capture.bin"), bytes);
    saveSettings({ ...loadSettings(), recordingDirectory: sourceAlias });
    try {
      sessionId = await insertSession("alias-car", "alias-track", "fm-2023", "race");
      canonicalSessionId = await insertSession("canonical-alias-car", "alias-track", "fm-2023", "race");
      await db.update(sessions).set({ rawFile: capture }).where(eq(sessions.id, sessionId)).run();
      await db.update(sessions).set({ rawFile: join(source, "test-game", "capture.bin") }).where(eq(sessions.id, canonicalSessionId)).run();

      await startRecordingDirectoryMove(destination);
      await waitForMove();

      const expected = join(await realpath(destination), "test-game", "capture.bin");
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(expected);
      expect((await db.select().from(sessions).where(eq(sessions.id, canonicalSessionId)).get())?.rawFile).toBe(expected);
      expect(await readFile(expected)).toEqual(bytes);
      await expect(readFile(join(source, "test-game", "capture.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (sessionId !== undefined) await deleteSession(sessionId);
      if (canonicalSessionId !== undefined) await deleteSession(canonicalSessionId);
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
      await rm(source, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });
  test("recovers both sides of the settings commit marker idempotently", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "raceiq-recording-recovery-")));
    const source = join(root, "source");
    const destination = join(root, "destination");
    const capture = join(source, "game", "capture.bin");
    const target = join(destination, "game", "capture.bin");
    const unrelatedSource = join(source, "keep.txt");
    const unrelatedDestination = join(destination, "keep.txt");
    const bytes = Buffer.from("verified recovery recording");
    const operationId = "11111111-1111-4111-8111-111111111111";
    const journalPath = join(resolveDataDir(), "recording-directory-move.json");
    let sessionId: number | undefined;
    await mkdir(join(source, "game"), { recursive: true });
    await mkdir(join(destination, "game"), { recursive: true });
    await writeFile(capture, bytes);
    await writeFile(target, bytes);
    await writeFile(unrelatedSource, "preserve source");
    await writeFile(unrelatedDestination, "preserve destination");
    sessionId = await insertSession("recovery-car", "recovery-track", "fm-2023");
    await db.update(sessions).set({ rawFile: capture }).where(eq(sessions.id, sessionId)).run();
    const digest = createHash("sha256").update(bytes).digest("hex");
    const journal = {
      version: 1,
      operationId,
      oldDirectory: await realpath(source),
      newDirectory: await realpath(destination),
      oldSetting: source,
      entries: [{ source: capture, destination: target, size: bytes.length, sha256: digest }],
      references: [{ sessionId, oldPath: capture, newPath: target }, { sessionId: 999999999, oldPath: join(source, "missing-parent", "nested", "deleted.bin"), newPath: join(destination, "missing-parent", "nested", "deleted.bin") }],
    };
    try {
      saveSettings({ ...loadSettings(), recordingDirectory: source });
      await writeFile(journalPath, JSON.stringify({ ...journal, references: [{ sessionId, oldPath: join(root, "outside.bin"), newPath: target }] }));
      await expect(recoverRecordingDirectoryMove()).rejects.toThrow("[RecordingStorage] Recovery required");
      expect(await readFile(target)).toEqual(bytes);
      expect(await readFile(capture)).toEqual(bytes);
      await writeFile(journalPath, JSON.stringify(journal));
      await recoverRecordingDirectoryMove();
      expect(loadSettings().recordingDirectory).toBe(source);
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(capture);
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(capture)).toEqual(bytes);
      expect(await readFile(unrelatedSource, "utf8")).toBe("preserve source");
      expect(await readFile(unrelatedDestination, "utf8")).toBe("preserve destination");

      await writeFile(target, bytes);
      await writeFile(journalPath, JSON.stringify(journal));
      saveSettings({ ...loadSettings(), recordingDirectory: destination });
      await recoverRecordingDirectoryMove();
      await recoverRecordingDirectoryMove();
      expect(loadSettings().recordingDirectory).toBe(destination);
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(target);
      await expect(readFile(capture)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(target)).toEqual(bytes);
      expect(await readFile(unrelatedSource, "utf8")).toBe("preserve source");
      expect(await readFile(unrelatedDestination, "utf8")).toBe("preserve destination");
    } finally {
      if (sessionId !== undefined) await deleteSession(sessionId);
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
      await rm(journalPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects relocation while real import activity counter is held", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-import-busy-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    const releaseImport = beginRecordingStorageImport();
    try {
      await expect(startRecordingDirectoryMove(destination)).rejects.toMatchObject({ code: "IMPORT_ACTIVE" });
      expect(loadSettings().recordingDirectory).toBe(source);
      expect(getRecordingDirectoryMoveStatus().state).not.toBe("moving");
      expect(await readdir(source)).toEqual([]);
      expect(await readdir(destination)).toEqual([]);
    } finally {
      releaseImport();
      await rm(root, { recursive: true, force: true });
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
    }
  });

  test("reserves concurrent move admission before asynchronous validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-concurrent-move-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    try {
      const first = startRecordingDirectoryMove(destination);
      await expect(startRecordingDirectoryMove(destination)).rejects.toMatchObject({ code: "MOVE_ACTIVE" });
      await first;
      await waitForMove();
      expect(loadSettings().recordingDirectory).toBe(await realpath(destination));
    } finally {
      await rm(root, { recursive: true, force: true });
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
    }
  });
  test("rejects relocation while recording is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-recording-active-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    try {
      await expect(startRecordingDirectoryMove(destination, { isSessionActive: () => true })).rejects.toMatchObject({ code: "RECORDING_ACTIVE" });
      expect(loadSettings().recordingDirectory).toBe(source);
      expect(getRecordingDirectoryMoveStatus().state).not.toBe("moving");
      expect(await readdir(source)).toEqual([]);
      expect(await readdir(destination)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
    }
  });

  test("rolls back source and destination when copying reports insufficient space", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-copy-failure-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    const capture = join(source, "game", "capture.bin");
    const bytes = Buffer.from("copy rollback source");
    await mkdir(join(source, "game"), { recursive: true });
    await mkdir(destination);
    await writeFile(capture, bytes);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    const target = join(await realpath(destination), "game", "capture.bin");
    try {
      await startRecordingDirectoryMove(destination, {
        copyFile: async (from, to, mode) => {
          if (to === target) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return fsCopyFile(from, to, mode);
        },
      });
      await waitForMoveError("INSUFFICIENT_SPACE");
      expect(loadSettings().recordingDirectory).toBe(source);
      expect(await readFile(capture)).toEqual(bytes);
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(resolveDataDir(), "recording-directory-move.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores references and removes verified copies when settings commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-settings-failure-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    const capture = join(source, "game", "capture.bin");
    const bytes = Buffer.from("settings rollback source");
    let sessionId: number | undefined;
    await mkdir(join(source, "game"), { recursive: true });
    await mkdir(destination);
    await writeFile(capture, bytes);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    const target = join(await realpath(destination), "game", "capture.bin");
    try {
      sessionId = await insertSession("settings-rollback-car", "track", "fm-2023");
      await db.update(sessions).set({ rawFile: capture }).where(eq(sessions.id, sessionId)).run();
      await startRecordingDirectoryMove(destination, {
        saveSettings: () => { throw new Error("injected settings save failure"); },
      });
      await waitForMoveError("STORAGE_IO_ERROR");
      expect(loadSettings().recordingDirectory).toBe(source);
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(capture);
      expect(await readFile(capture)).toEqual(bytes);
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(resolveDataDir(), "recording-directory-move.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (sessionId !== undefined) await deleteSession(sessionId);
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries source cleanup after a committed move", async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-source-cleanup-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    const capture = join(source, "game", "capture.bin");
    const bytes = Buffer.from("source cleanup retry");
    let sessionId: number | undefined;
    await mkdir(join(source, "game"), { recursive: true });
    await mkdir(destination);
    await writeFile(capture, bytes);
    saveSettings({ ...loadSettings(), recordingDirectory: source });
    const canonicalCapture = join(await realpath(source), "game", "capture.bin");
    const target = join(await realpath(destination), "game", "capture.bin");
    try {
      sessionId = await insertSession("cleanup-retry-car", "track", "fm-2023");
      await db.update(sessions).set({ rawFile: capture }).where(eq(sessions.id, sessionId)).run();
      await startRecordingDirectoryMove(destination, {
        unlink: async (path) => {
          if (path === canonicalCapture) throw Object.assign(new Error("source busy"), { code: "EACCES" });
          return fsUnlink(path);
        },
      });
      await waitForMoveError("SOURCE_CLEANUP_FAILED");
      expect(loadSettings().recordingDirectory).toBe(await realpath(destination));
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(target);
      expect(await readFile(capture)).toEqual(bytes);
      expect(await readFile(target)).toEqual(bytes);

      await expect(startRecordingDirectoryMove(destination)).resolves.toMatchObject({ noOp: true });
      expect(getRecordingDirectoryMoveStatus().state).toBe("complete");
      expect((await db.select().from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(target);
      await expect(readFile(capture)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(target)).toEqual(bytes);
    } finally {
      if (sessionId !== undefined) await deleteSession(sessionId);
      saveSettings({ ...loadSettings(), recordingDirectory: originalDirectory ?? null });
      await rm(root, { recursive: true, force: true });
    }
  });
});
