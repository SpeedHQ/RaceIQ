import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { ROOT_DIR } from "./root";
import { LIVE_ENGINEER_AUDIO_PACKAGE } from "@raceiq/live-engineer/audio-package";
import { installPack, validatePack } from "@raceiq/live-engineer/audio-installation";
const SOURCE = resolve(ROOT_DIR, "assets/live-engineer/qwen-v3");
const INSTALL_ROOT = resolve(process.env.DATA_DIR ?? resolve(ROOT_DIR, "data"), "userdata", "voice-packs");
const PACK_NAME = "live-engineer";

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
    const manifest = await validatePack(SOURCE, LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion);
    await visit(SOURCE, `${PACK_NAME}/qwen-v3`);
    const bytes = zipSync(data, { level: 6 });
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes);
    const metadata = { engineVersion: manifest.engineVersion, catalogVersion: manifest.catalogVersion, packageVersion: manifest.packageVersion, language: manifest.language, sha256: createHash("sha256").update(bytes).digest("hex") };
    const metadataPath = /\.zip$/i.test(target) ? target.replace(/\.zip$/i, ".json") : `${target}.json`;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
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
