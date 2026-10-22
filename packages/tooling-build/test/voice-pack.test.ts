import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { installPack } from "../src/voice-pack";
import { LIVE_ENGINEER_AUDIO_PACKAGE } from "@raceiq/live-engineer/audio-package";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createArchive(directory: string, omitClip = false, metadata: Record<string, unknown> = {}): string {
  const clip = new Uint8Array([1, 2, 3]);
  const full = new Uint8Array([4, 5, 6]);
  const manifest = {
    ...LIVE_ENGINEER_AUDIO_PACKAGE,
    ...metadata,
    clips: [{ path: "chunks/segment.flac", sha256: createHash("sha256").update(clip).digest("hex") }],
    fullLines: [{ path: "full/line.flac", sha256: createHash("sha256").update(full).digest("hex") }],
  };
  const files: Record<string, Uint8Array> = {
    "live-engineer/qwen-v3/manifest.json": strToU8(JSON.stringify(manifest)),
    "live-engineer/qwen-v3/full/line.flac": full,
  };
  if (!omitClip) files["live-engineer/qwen-v3/chunks/segment.flac"] = clip;
  const archive = join(directory, "voice-pack.zip");
  writeFileSync(archive, zipSync(files));
  return archive;
}

test("installs complete versioned voice pack into expected served layout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-voice-pack-test-"));
  temporaryDirectories.push(directory);
  const installRoot = join(directory, "userdata", "voice-packs");
  const archive = createArchive(directory);

  await installPack(archive, installRoot);

  expect([...readFileSync(join(installRoot, "live-engineer", "qwen-v3", "chunks", "segment.flac"))]).toEqual([1, 2, 3]);
});

test("rejects incomplete replacement without changing existing installation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-voice-pack-test-"));
  temporaryDirectories.push(directory);
  const installRoot = join(directory, "userdata", "voice-packs");
  const installed = join(installRoot, "live-engineer", "qwen-v3");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "sentinel.txt"), "previous pack");

  await expect(installPack(createArchive(directory, true), installRoot)).rejects.toThrow();

  expect(readFileSync(join(installed, "sentinel.txt"), "utf8")).toBe("previous pack");
});

test("rejects unsupported engine, revision and language without replacing valid installed audio", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-voice-pack-test-"));
  temporaryDirectories.push(directory);
  const installRoot = join(directory, "userdata", "voice-packs");
  await installPack(createArchive(directory), installRoot);
  const installedClip = join(installRoot, "live-engineer", "qwen-v3", "chunks", "segment.flac");
  for (const metadata of [{ packageVersion: "2.0.0" }, { packageVersion: undefined }, { engineVersion: 2 }, { language: "fr" }, { catalogVersion: "2.0.0" }]) {
    await expect(installPack(createArchive(directory, false, metadata), installRoot)).rejects.toThrow();
    expect([...readFileSync(installedClip)]).toEqual([1, 2, 3]);
  }
});
