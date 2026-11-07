import descriptor from "../audio-package.json";
import { LIVE_ENGINEER_AUDIO_CATALOG_VERSION } from "@raceiq/shared/racing/live/engineer-contracts";

export function liveEngineerVoicePackageUrl(version = descriptor.packageVersion, language = descriptor.language): string {
  return `https://github.com/SpeedHQ/RaceIQ/releases/download/voice-pack-${language}-v${version}/live-engineer-qwen-v3-${language}-${version}.zip`;
}

export function compareVoicePackageVersions(left: string, right: string): number | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(left) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(right)) return undefined;
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  if (!a.every(Number.isSafeInteger) || !b.every(Number.isSafeInteger)) return undefined;
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

export const LIVE_ENGINEER_AUDIO_PACKAGE = {
  ...descriptor,
  catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION,
  downloadUrl: liveEngineerVoicePackageUrl(),
} as const;

export type LiveEngineerVoicePackStatus = {
  state: "download-required" | "update-required" | "ready";
  requiredVersion: string;
  installedVersion: string | null;
  requiredEngineVersion: number;
  installedEngineVersion: number | null;
  language: string;
  downloadUrl: string;
  requiredCatalogVersion: string;
  installedCatalogVersion: string | null;
  installedLanguage: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastChecked: string | null;
  updateError: string | null;
  installing: boolean;
};

export interface LiveEngineerVoicePackageIdentity {
  engineVersion: number;
  packageVersion: string;
  language: string;
  catalogVersion: string;
}

export interface LiveEngineerVoicePackageRelease extends LiveEngineerVoicePackageIdentity {
  sha256: string;
}

export interface LiveEngineerAudioPackageManifest extends LiveEngineerVoicePackageIdentity {
  clips: { path: string; sha256: string }[];
  fullLines: { path: string; sha256: string }[];
}

export function isSupportedLiveEngineerVoicePackage(value: unknown): value is LiveEngineerVoicePackageIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  const order = typeof identity.packageVersion === "string" ? compareVoicePackageVersions(identity.packageVersion, descriptor.packageVersion) : undefined;
  return order !== undefined && order >= 0 && identity.engineVersion === descriptor.engineVersion &&
    identity.language === descriptor.language && identity.catalogVersion === LIVE_ENGINEER_AUDIO_CATALOG_VERSION;
}

export function isCompatibleLiveEngineerAudioManifest(value: unknown): value is LiveEngineerAudioPackageManifest {
  if (!isSupportedLiveEngineerVoicePackage(value)) return false;
  const manifest = value as unknown as Record<string, unknown>;
  return [manifest.clips, manifest.fullLines].every((entries) => Array.isArray(entries) && entries.length > 0 &&
    entries.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const { path, sha256 } = entry as Record<string, unknown>;
      return typeof path === "string" && !path.includes("\\") && !path.includes(":") &&
        path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
        typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256);
    }));
}
