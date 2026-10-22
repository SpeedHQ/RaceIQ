import descriptor from "../audio-package.json";
import { LIVE_ENGINEER_AUDIO_CATALOG_VERSION } from "@raceiq/shared/racing/live/engineer-contracts";

export const LIVE_ENGINEER_AUDIO_PACKAGE = {
  ...descriptor,
  catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION,
  downloadUrl: `https://github.com/SpeedHQ/RaceIQ/releases/download/voice-pack-${descriptor.language}-v${descriptor.packageVersion}/live-engineer-qwen-v3-${descriptor.language}-${descriptor.packageVersion}.zip`,
} as const;

export type LiveEngineerVoicePackStatus = {
  state: "download-required" | "update-required" | "ready";
  requiredVersion: string;
  installedVersion: string | null;
  requiredEngineVersion: number;
  installedEngineVersion: number | null;
  language: string;
  downloadUrl: string;
};

export interface LiveEngineerAudioPackageManifest {
  engineVersion: number;
  packageVersion: string;
  language: string;
  catalogVersion: string;
  clips: { path: string; sha256: string }[];
  fullLines: { path: string; sha256: string }[];
}

export function isCompatibleLiveEngineerAudioManifest(value: unknown): value is LiveEngineerAudioPackageManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.engineVersion !== descriptor.engineVersion || manifest.packageVersion !== descriptor.packageVersion ||
    manifest.language !== descriptor.language || manifest.catalogVersion !== LIVE_ENGINEER_AUDIO_CATALOG_VERSION) return false;
  return [manifest.clips, manifest.fullLines].every((entries) => Array.isArray(entries) && entries.length > 0 &&
    entries.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const { path, sha256 } = entry as Record<string, unknown>;
      return typeof path === "string" && !path.includes("\\") && !path.includes(":") &&
        path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
        typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256);
    }));
}
