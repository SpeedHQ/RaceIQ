import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { installPack, validatePack } from "@raceiq/live-engineer/audio-installation";
import { LIVE_ENGINEER_AUDIO_PACKAGE, isSupportedLiveEngineerVoicePackage } from "@raceiq/live-engineer/audio-package";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-audio-installation-"));
  directories.push(directory);
  return directory;
}
function archive(directory: string, packageVersion = LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion, overrides: Record<string, unknown> = {}): string {
  const clip = new Uint8Array([1, 2, 3]), full = new Uint8Array([4, 5, 6]);
  const manifest = { ...LIVE_ENGINEER_AUDIO_PACKAGE, packageVersion, ...overrides,
    clips: [{ path: "chunks/segment.flac", sha256: createHash("sha256").update(clip).digest("hex") }],
    fullLines: [{ path: "full/line.flac", sha256: createHash("sha256").update(full).digest("hex") }] };
  const file = join(directory, "pack.zip");
  writeFileSync(file, zipSync({ "live-engineer/qwen-v3/manifest.json": strToU8(JSON.stringify(manifest)),
    "live-engineer/qwen-v3/chunks/segment.flac": clip, "live-engineer/qwen-v3/full/line.flac": full }));
  return file;
}

test("accepts compatible newer revisions but enforces explicitly selected revision and archive digest", async () => {
  const directory = fixture(), installRoot = join(directory, "voice-packs"), selected = "1.0.1";
  const zip = archive(directory, selected), digest = createHash("sha256").update(readFileSync(zip)).digest("hex");
  await installPack(zip, installRoot, selected, digest);
  const root = join(installRoot, "live-engineer", "qwen-v3");
  expect((await validatePack(root)).packageVersion).toBe(selected);
  expect(isSupportedLiveEngineerVoicePackage({ ...LIVE_ENGINEER_AUDIO_PACKAGE, packageVersion: selected })).toBe(true);
  await expect(installPack(zip, installRoot, LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion)).rejects.toThrow();
  await expect(installPack(zip, installRoot, selected, "0".repeat(64))).rejects.toThrow();
  expect(readFileSync(join(root, "chunks/segment.flac"))).toEqual(Buffer.from([1, 2, 3]));
});

test("rejects unsupported identities and corrupt assets without replacing prior installation", async () => {
  const directory = fixture(), installRoot = join(directory, "voice-packs"), original = archive(directory);
  await installPack(original, installRoot);
  const installed = join(installRoot, "live-engineer", "qwen-v3", "chunks/segment.flac");
  for (const [version, overrides] of [["0.9.9", {}], ["bad", {}], [LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion, { engineVersion: 2 }], [LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion, { language: "fr" }], [LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion, { catalogVersion: "2.0.0" }]] as const) {
    const candidate = archive(directory, version, overrides);
    await expect(installPack(candidate, installRoot)).rejects.toThrow();
    expect(readFileSync(installed)).toEqual(Buffer.from([1, 2, 3]));
  }
  const corrupt = archive(directory);
  const files = unzipSync(readFileSync(corrupt));
  files["live-engineer/qwen-v3/chunks/segment.flac"]![0] ^= 0xff;
  writeFileSync(corrupt, zipSync(files));
  await expect(installPack(corrupt, installRoot)).rejects.toThrow();
  expect(readFileSync(installed)).toEqual(Buffer.from([1, 2, 3]));
});

test("rejects archive traversal and duplicate paths", async () => {
  const directory = fixture(), installRoot = join(directory, "voice-packs");
  const traversal = join(directory, "traversal.zip");
  writeFileSync(traversal, zipSync({ "../escape": strToU8("no") }));
  await expect(installPack(traversal, installRoot)).rejects.toThrow();
  const duplicate = join(directory, "duplicate.zip");
  const clip = new Uint8Array([1]);
  const manifest = { ...LIVE_ENGINEER_AUDIO_PACKAGE, clips: [{ path: "same.flac", sha256: createHash("sha256").update(clip).digest("hex") }], fullLines: [{ path: "same.flac", sha256: createHash("sha256").update(clip).digest("hex") }] };
  writeFileSync(duplicate, zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "same.flac": clip }));
  await expect(installPack(duplicate, installRoot)).rejects.toThrow();
  expect(existsSync(join(directory, "escape"))).toBe(false);
});

test("rejects oversized declared extraction before publishing files", async () => {
  const directory = fixture(), installRoot = join(directory, "voice-packs");
  const file = join(directory, "oversized.zip");
  const bytes = zipSync({ "large.flac": new Uint8Array([1]) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 28 < bytes.length; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, 600 * 1024 * 1024, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, 600 * 1024 * 1024, true);
  }
  writeFileSync(file, bytes);
  await expect(installPack(file, installRoot)).rejects.toThrow();
  expect(existsSync(join(installRoot, "live-engineer"))).toBe(false);
});
