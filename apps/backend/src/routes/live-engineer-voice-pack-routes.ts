import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { USER_VOICE_PACKS_DIR } from "@raceiq/shared/platform/runtime/data-paths";
import { isCompatibleLiveEngineerAudioManifest, LIVE_ENGINEER_AUDIO_PACKAGE, type LiveEngineerVoicePackStatus } from "@raceiq/live-engineer/audio-package";


export async function readVoicePackStatus(root = join(USER_VOICE_PACKS_DIR, "live-engineer", "qwen-v3")): Promise<LiveEngineerVoicePackStatus> {
  const result: LiveEngineerVoicePackStatus = {
    state: "update-required",
    requiredVersion: LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion,
    installedVersion: null,
    requiredEngineVersion: LIVE_ENGINEER_AUDIO_PACKAGE.engineVersion,
    installedEngineVersion: null,
    language: LIVE_ENGINEER_AUDIO_PACKAGE.language,
    downloadUrl: LIVE_ENGINEER_AUDIO_PACKAGE.downloadUrl,
  };
  let text: string;
  try { text = await readFile(join(root, "manifest.json"), "utf8"); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    return { ...result, state: "download-required" };
  }
  let manifest: unknown;
  try { manifest = JSON.parse(text); }
  catch { return result; }
  if (manifest && typeof manifest === "object") {
    if ("packageVersion" in manifest && typeof manifest.packageVersion === "string") result.installedVersion = manifest.packageVersion;
    if ("engineVersion" in manifest && typeof manifest.engineVersion === "number" && Number.isInteger(manifest.engineVersion)) result.installedEngineVersion = manifest.engineVersion;
  }
  if (!isCompatibleLiveEngineerAudioManifest(manifest)) return result;
  const available = await Promise.all([...manifest.clips, ...manifest.fullLines].map(async (entry) => {
    try { const file = await stat(join(root, entry.path)); return file.isFile() && file.size > 0; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
  }));
  return { ...result, state: available.every(Boolean) ? "ready" : "update-required" };
}

export const liveEngineerVoicePackRoutes = new Hono().get("/api/live-engineer/voice-pack", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await readVoicePackStatus());
});
