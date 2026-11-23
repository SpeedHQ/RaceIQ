import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { isCompatibleLiveEngineerAudioManifest, type LiveEngineerAudioPackageManifest } from "./audio-package";
import { USER_VOICE_PACKS_DIR } from "@raceiq/shared/platform/runtime/data-paths";

const PACK_NAME = "live-engineer";
const INSTALL_ROOT = USER_VOICE_PACKS_DIR;
const MANIFEST = "manifest.json";
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

const safePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes(":") && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
const inside = (root: string, file: string) => file.startsWith(root + sep);

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest("hex");
}

export async function validatePack(root: string, expectedPackageVersion?: string): Promise<LiveEngineerAudioPackageManifest> {
  const manifest: unknown = JSON.parse(await readFile(join(root, MANIFEST), "utf8"));
  if (!isCompatibleLiveEngineerAudioManifest(manifest)) throw new Error("Unsupported live-engineer audio package version or catalog");
  if (expectedPackageVersion !== undefined && manifest.packageVersion !== expectedPackageVersion) throw new Error("Unexpected live-engineer package revision");
  const paths = new Set<string>([MANIFEST]);
  for (const entry of [...manifest.clips, ...manifest.fullLines]) {
    if (!safePath(entry.path) || !HEX_SHA256.test(entry.sha256) || paths.has(entry.path)) throw new Error("Invalid live-engineer manifest entry");
    paths.add(entry.path);
    const file = resolve(root, entry.path);
    if (!inside(resolve(root), file) || await hashFile(file) !== entry.sha256) throw new Error(`Missing or corrupt voice asset: ${entry.path}`);
  }
  return manifest;
}

export async function installPack(archive: string, installRoot = INSTALL_ROOT, expectedPackageVersion?: string, expectedArchiveSha256?: string): Promise<void> {
  if (expectedArchiveSha256 !== undefined && !HEX_SHA256.test(expectedArchiveSha256)) throw new Error("Invalid expected voice-pack SHA-256");
  if ((await stat(archive)).size > MAX_ARCHIVE_BYTES) throw new Error("Voice-pack archive exceeds size limit");
  const archiveBytes = await readFile(archive);
  if (archiveBytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Voice-pack archive exceeds size limit");
  if (expectedArchiveSha256 !== undefined && createHash("sha256").update(archiveBytes).digest("hex") !== expectedArchiveSha256) throw new Error("Voice-pack archive SHA-256 mismatch");
  let fileCount = 0;
  let unpackedBytes = 0;
  const files = unzipSync(archiveBytes, { filter: (file) => {
    fileCount++;
    unpackedBytes += file.originalSize;
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || fileCount > MAX_FILES || unpackedBytes > MAX_UNPACKED_BYTES) throw new Error("Voice-pack archive exceeds extraction limits");
    return true;
  } });
  await mkdir(installRoot, { recursive: true });
  const stage = await mkdtemp(join(installRoot, ".live-engineer-stage-"));
  try {
    const packRoot = join(stage, "pack");
    await mkdir(packRoot);
    for (const [name, bytes] of Object.entries(files)) {
      const prefix = `${PACK_NAME}/qwen-v3/`;
      const normalized = name.startsWith(prefix) ? name.slice(prefix.length) : name.startsWith("qwen-v3/") ? name.slice("qwen-v3/".length) : name;
      if (!normalized || !safePath(normalized)) throw new Error("Unsafe voice-pack archive path");
      const target = resolve(packRoot, normalized);
      if (!inside(resolve(packRoot), target)) throw new Error("Unsafe voice-pack archive path");
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
    await validatePack(packRoot, expectedPackageVersion);
    const target = join(installRoot, PACK_NAME, "qwen-v3"), backup = join(stage, "previous");
    await mkdir(join(installRoot, PACK_NAME), { recursive: true });
    let hadPrevious = false;
    try { await rename(target, backup); hadPrevious = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(packRoot, target); }
    catch (error) { if (hadPrevious) await rename(backup, target); throw error; }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

