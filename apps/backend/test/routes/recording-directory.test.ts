import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { startRecordingDirectoryMove, getRecordingDirectoryMoveStatus } from "@raceiq/backend-core/session-capture/relocate-recordings";

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
});
