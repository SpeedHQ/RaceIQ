import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync, zipSync } from "fflate";
import { ROOT_DIR } from "./root";
import { isCompatibleLiveEngineerAudioManifest, LIVE_ENGINEER_AUDIO_PACKAGE, type LiveEngineerAudioPackageManifest } from "@raceiq/live-engineer/audio-package";
const PACK_NAME = "live-engineer";
const INSTALL_ROOT = resolve(process.env.DATA_DIR ?? resolve(ROOT_DIR, "data"), "userdata", "voice-packs");
const SOURCE = resolve(ROOT_DIR, "assets/live-engineer/qwen-v3");
const MANIFEST = "manifest.json";
const HEX_SHA256 = /^[a-f0-9]{64}$/;

const safePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes(":") && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
const inside = (root: string, file: string) => file.startsWith(root + sep);

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest("hex");
}

export async function validatePack(root: string): Promise<LiveEngineerAudioPackageManifest> {
  const manifest: unknown = JSON.parse(await readFile(join(root, MANIFEST), "utf8"));
  if (!isCompatibleLiveEngineerAudioManifest(manifest)) throw new Error("Unsupported live-engineer audio package version or catalog");
  const paths = new Set<string>([MANIFEST]);
  for (const entry of [...manifest.clips, ...manifest.fullLines]) {
    if (!safePath(entry.path) || !HEX_SHA256.test(entry.sha256) || paths.has(entry.path)) throw new Error("Invalid live-engineer manifest entry");
    paths.add(entry.path);
    const file = resolve(root, entry.path);
    if (!inside(resolve(root), file) || await hashFile(file) !== entry.sha256) throw new Error(`Missing or corrupt voice asset: ${entry.path}`);
  }
  return manifest;
}


export async function installPack(archive: string, installRoot = INSTALL_ROOT): Promise<void> {
  await mkdir(installRoot, { recursive: true });
  const stage = await mkdtemp(join(installRoot, ".live-engineer-stage-"));
  try {
    const archiveBytes = new Uint8Array(await readFile(archive));
    const files = unzipSync(archiveBytes);
    const packRoot = join(stage, "pack");
    await mkdir(packRoot);
    for (const [name, bytes] of Object.entries(files)) {
      const prefix = `${PACK_NAME}/qwen-v3/`;
      const normalized = name.startsWith(prefix) ? name.slice(prefix.length) : name.startsWith("qwen-v3/") ? name.slice("qwen-v3/".length) : name;
      if (!normalized || !safePath(normalized)) throw new Error("Unsafe voice-pack archive path");
      const target = resolve(packRoot, normalized);
      if (!inside(resolve(packRoot), target)) throw new Error("Unsafe voice-pack archive path");
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    await validatePack(packRoot);
    const target = join(installRoot, PACK_NAME, "qwen-v3"), backup = join(stage, "previous");
    await mkdir(join(installRoot, PACK_NAME), { recursive: true });
    let hadPrevious = false;
    try { await rename(target, backup); hadPrevious = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(packRoot, target); }
    catch (error) { if (hadPrevious) await rename(backup, target); throw error; }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function main() {
  const [action, argument] = process.argv.slice(2);
  if (action === "build") {
    const target = resolve(argument ?? resolve(ROOT_DIR, `live-engineer-qwen-v3-${LIVE_ENGINEER_AUDIO_PACKAGE.language}-${LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion}.zip`));
    const data: Record<string, Uint8Array> = {};
    async function visit(directory: string, prefix: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name), name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await visit(file, name);
        else data[name] = new Uint8Array(await readFile(file));
      }
    }
    await validatePack(SOURCE);
    await visit(SOURCE, `${PACK_NAME}/qwen-v3`);
    const bytes = zipSync(data, { level: 6 });
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes);
    console.log(`Built ${target}`);
  } else if (action === "install") {
    if (!argument) throw new Error("Usage: bun packages/tooling-build/src/voice-pack.ts install <zip-path|URL>");
    if (/^https?:\/\//.test(argument)) {
      const response = await fetch(argument);
      if (!response.ok) throw new Error(`Voice pack download failed: HTTP ${response.status}`);
      const temporary = join(tmpdir(), `raceiq-${Date.now()}-${basename(new URL(argument).pathname)}`);
      try { await writeFile(temporary, new Uint8Array(await response.arrayBuffer())); await installPack(temporary); }
      finally { await rm(temporary, { force: true }); }
    } else await installPack(resolve(argument));
    console.log(`Installed ${PACK_NAME} pack in ${INSTALL_ROOT}`);
  } else throw new Error(`Usage: bun packages/tooling-build/src/voice-pack.ts <build [zip-path]|install <zip-path|URL>>`);
}

if (import.meta.main) await main();
