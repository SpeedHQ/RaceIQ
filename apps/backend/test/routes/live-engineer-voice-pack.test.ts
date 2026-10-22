import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_ENGINEER_AUDIO_PACKAGE } from "@raceiq/live-engineer/audio-package";
import { readVoicePackStatus } from "../../src/routes/live-engineer-voice-pack-routes";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raceiq-pack-status-"));
  directories.push(root);
  await mkdir(join(root, "chunks"));
  await writeFile(join(root, "chunks/clip.flac"), new Uint8Array([1]));
  const manifest = { ...LIVE_ENGINEER_AUDIO_PACKAGE, clips: [{ path: "chunks/clip.flac", sha256: "a".repeat(64) }], fullLines: [{ path: "chunks/clip.flac", sha256: "a".repeat(64) }] };
  return { root, manifest };
}

test("missing pack requires download, matching complete pack becomes ready on recheck", async () => {
  const { root, manifest } = await fixture();
  expect(await readVoicePackStatus(root)).toMatchObject({ state: "download-required", requiredVersion: LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion, requiredEngineVersion: LIVE_ENGINEER_AUDIO_PACKAGE.engineVersion, language: "en", installedVersion: null, downloadUrl: LIVE_ENGINEER_AUDIO_PACKAGE.downloadUrl });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  expect(await readVoicePackStatus(root)).toMatchObject({ state: "ready", installedVersion: manifest.packageVersion, installedEngineVersion: manifest.engineVersion });
});

for (const patch of [
  { packageVersion: "0.9.0" }, { packageVersion: "2.0.0" }, { packageVersion: undefined },
  { engineVersion: 0 }, { engineVersion: 2 }, { language: "fr" },
  { catalogVersion: "live-engineer-qwen-v3" }, { catalogVersion: "2.0.0" },
  { clips: [{ path: "../outside.flac", sha256: "a".repeat(64) }] },
]) {
  test(`unsupported pack metadata requires update: ${JSON.stringify(patch)}`, async () => {
    const { root, manifest } = await fixture();
    await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, ...patch }));
    expect((await readVoicePackStatus(root)).state).toBe("update-required");
  });
}

test("corrupt manifest and missing referenced file require update rather than false readiness", async () => {
  const { root, manifest } = await fixture();
  await writeFile(join(root, "manifest.json"), "invalid json");
  expect((await readVoicePackStatus(root)).state).toBe("update-required");
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await rm(join(root, "chunks/clip.flac"));
  expect((await readVoicePackStatus(root)).state).toBe("update-required");
});
