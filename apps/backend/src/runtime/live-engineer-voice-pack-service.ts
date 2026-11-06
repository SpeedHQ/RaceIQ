import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout, setInterval, clearTimeout, clearInterval } from "node:timers";
import { USER_VOICE_PACKS_DIR } from "@raceiq/shared/platform/runtime/data-paths";
import {
  compareVoicePackageVersions,
  isCompatibleLiveEngineerAudioManifest,
  isSupportedLiveEngineerVoicePackage,
  LIVE_ENGINEER_AUDIO_PACKAGE,
  liveEngineerVoicePackageUrl,
  type LiveEngineerVoicePackageRelease,
  type LiveEngineerVoicePackStatus,
} from "@raceiq/live-engineer/audio-package";
import { installPack } from "@raceiq/live-engineer/audio-installation";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";

const API_URL = "https://api.github.com/repos/SpeedHQ/RaceIQ/releases?per_page=100";
const RELEASE_BASE = "https://github.com/SpeedHQ/RaceIQ/releases/download";
const SHA = /^[a-f0-9]{64}$/;
const START_DELAY_MS = 10_000;
const INTERVAL_MS = 4 * 60 * 60 * 1000;

type Candidate = LiveEngineerVoicePackageRelease & { metadataUrl: string; archiveUrl: string };
export interface LiveEngineerVoicePackServiceOptions {
  fetchImpl?: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  now?: () => Date;
  root?: string;
  isFeatureEnabled?: () => boolean;
  isAutomaticCheckEnabled?: () => boolean;
  broadcast?: (event: { type: "live-engineer-package-update" }) => void;
  timers?: {
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> | number;
    setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> | number;
    clearTimeout(timer: ReturnType<typeof setTimeout> | number): void;
    clearInterval(timer: ReturnType<typeof setInterval> | number): void;
  };
}
export interface LiveEngineerVoicePackService {
  getStatus(): Promise<LiveEngineerVoicePackStatus>;
  check(): Promise<LiveEngineerVoicePackStatus>;
  checkAutomatic(): Promise<LiveEngineerVoicePackStatus>;
  install(): Promise<LiveEngineerVoicePackStatus>;
  isInstalling(): boolean;
  startAutomaticChecks(): () => void;
}

function defaultFeatureEnabled(): boolean {
  return serverReleaseFeatures.liveSpotterEngineer;
}
function defaultAutomaticEnabled(): boolean {
  const settings = loadSettings();
  return settings.radioSpotterEnabled || settings.radioRaceEngineerEnabled;
}
function parseRelease(value: unknown, locale: string): Candidate | null {
  if (!value || typeof value !== "object") return null;
  const release = value as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return null;
  const match = /^voice-pack-([a-z]{2})-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(release.tag_name);
  if (!match || match[1] !== locale) return null;
  const version = `${match[2]}.${match[3]}.${match[4]}`;
  const order = compareVoicePackageVersions(version, LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion);
  if (order === undefined || order < 0) return null;
  return {
    engineVersion: LIVE_ENGINEER_AUDIO_PACKAGE.engineVersion,
    catalogVersion: LIVE_ENGINEER_AUDIO_PACKAGE.catalogVersion,
    language: locale,
    packageVersion: version,
    sha256: "",
    metadataUrl: `${RELEASE_BASE}/${release.tag_name}/live-engineer-qwen-v3-${locale}-${version}.json`,
    archiveUrl: `${RELEASE_BASE}/${release.tag_name}/live-engineer-qwen-v3-${locale}-${version}.zip`,
  };
}

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

async function downloadBoundedResponse(response: Response, path: string): Promise<void> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) throw new Error("Voice package archive exceeds size limit");
  const output = await open(path, "w");
  const reader = response.body?.getReader();
  try {
    if (!reader) return;
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error("Voice package archive exceeds size limit");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await output.write(value, offset, value.byteLength - offset, null);
        if (bytesWritten === 0) throw new Error("Unable to write voice package archive");
        offset += bytesWritten;
      }
    }
  } finally {
    reader?.releaseLock();
    await output.close();
  }
}
export function createLiveEngineerVoicePackService(options: LiveEngineerVoicePackServiceOptions = {}): LiveEngineerVoicePackService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const root = options.root ?? join(USER_VOICE_PACKS_DIR, "live-engineer", "qwen-v3");
  const featureEnabled = options.isFeatureEnabled ?? defaultFeatureEnabled;
  const automaticEnabled = options.isAutomaticCheckEnabled ?? defaultAutomaticEnabled;
  const broadcast = options.broadcast ?? ((event) => wsManager.broadcastNotification(event));
  const timers = options.timers ?? { setTimeout, setInterval, clearTimeout, clearInterval };
  let latest: Candidate | null = null;
  let lastChecked: string | null = null;
  let updateError: string | null = null;
  let checkFlight: Promise<void> | null = null;
  let installFlight: Promise<LiveEngineerVoicePackStatus> | null = null;
  let installing = false;

  async function installed(): Promise<{ version: string | null; engine: number | null; catalog: string | null; language: string | null; ready: boolean; present: boolean }> {
    let raw: string;
    try { raw = await readFile(join(root, "manifest.json"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: null, engine: null, catalog: null, language: null, ready: false, present: false };
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { version: null, engine: null, catalog: null, language: null, ready: false, present: true }; }
    const identity = value && typeof value === "object" ? value as Record<string, unknown> : {};
    let valid = false;
    if (isCompatibleLiveEngineerAudioManifest(value)) {
      const files = await Promise.all([...value.clips, ...value.fullLines].map(async ({ path }) => {
        try { const details = await stat(join(root, path)); return details.isFile() && details.size > 0; }
        catch { return false; }
      }));
      valid = files.every(Boolean);
    }
    return {
      version: typeof identity.packageVersion === "string" ? identity.packageVersion : null,
      engine: typeof identity.engineVersion === "number" ? identity.engineVersion : null,
      catalog: typeof identity.catalogVersion === "string" ? identity.catalogVersion : null,
      language: typeof identity.language === "string" ? identity.language : null,
      ready: valid,
      present: true,
    };
  }

  async function status(): Promise<LiveEngineerVoicePackStatus> {
    const pack = await installed();
    const supported = pack.ready && isSupportedLiveEngineerVoicePackage({ packageVersion: pack.version, engineVersion: pack.engine, catalogVersion: pack.catalog, language: pack.language });
    const updateAvailable = latest !== null && (!supported || !pack.version || (compareVoicePackageVersions(latest.packageVersion, pack.version) ?? -1) > 0);
    return {
      state: supported ? "ready" : pack.present ? "update-required" : "download-required",
      requiredVersion: LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion,
      installedVersion: pack.version,
      requiredEngineVersion: LIVE_ENGINEER_AUDIO_PACKAGE.engineVersion,
      installedEngineVersion: pack.engine,
      language: LIVE_ENGINEER_AUDIO_PACKAGE.language,
      downloadUrl: liveEngineerVoicePackageUrl(),
      requiredCatalogVersion: LIVE_ENGINEER_AUDIO_PACKAGE.catalogVersion,
      installedCatalogVersion: pack.catalog,
      installedLanguage: pack.language,
      latestVersion: latest?.packageVersion ?? null,
      updateAvailable,
      lastChecked,
      updateError,
      installing,
    };
  }

  async function discover(automatic: boolean): Promise<void> {
    try {
      if (!featureEnabled() || (automatic && !automaticEnabled())) throw new Error("automatic-check-disabled");
      const releasesResponse = await fetchImpl(API_URL, { headers: { Accept: "application/vnd.github+json" } });
      if (!releasesResponse.ok) throw new Error(`GitHub releases request failed (${releasesResponse.status})`);
      const releases: unknown = await releasesResponse.json();
      if (!Array.isArray(releases)) throw new Error("Invalid GitHub releases response");
      const possible = releases.map((entry) => parseRelease(entry, LIVE_ENGINEER_AUDIO_PACKAGE.language)).filter((entry): entry is Candidate => entry !== null);
      const candidates: Candidate[] = [];
      let metadataFailures = 0;
      for (const candidate of possible) {
        if (!featureEnabled() || (automatic && !automaticEnabled())) throw new Error("automatic-check-disabled");
        let response: Response;
        try { response = await fetchImpl(candidate.metadataUrl, { headers: { Accept: "application/json" } }); }
        catch { metadataFailures += 1; continue; }
        if (!response.ok) { metadataFailures += 1; continue; }
        let metadata: unknown;
        try { metadata = await response.json(); } catch { metadataFailures += 1; continue; }
        if (!metadata || typeof metadata !== "object") { metadataFailures += 1; continue; }
        const item = metadata as Record<string, unknown>;
        if (typeof item.packageVersion !== "string" || typeof item.language !== "string" ||
            typeof item.engineVersion !== "number" || !Number.isInteger(item.engineVersion) ||
            typeof item.catalogVersion !== "string" || typeof item.sha256 !== "string" || !SHA.test(item.sha256)) {
          metadataFailures += 1;
          continue;
        }
        if (item.packageVersion !== candidate.packageVersion || item.language !== candidate.language ||
            item.engineVersion !== candidate.engineVersion || item.catalogVersion !== candidate.catalogVersion) continue;
        candidates.push({ ...candidate, sha256: item.sha256 });
      }
      candidates.sort((a, b) => (compareVoicePackageVersions(b.packageVersion, a.packageVersion) ?? 0));
      latest = candidates[0] ?? null;
      updateError = candidates.length === 0 && metadataFailures > 0 ? "No valid voice-package release metadata was found" : null;
    } catch (error) {
      latest = null;
      updateError = error instanceof Error ? error.message : String(error);
    } finally {
      lastChecked = now().toISOString();
      broadcast({ type: "live-engineer-package-update" });
    }
  }

  async function check(automatic = false): Promise<LiveEngineerVoicePackStatus> {
    if (!featureEnabled()) throw new Error("feature-disabled");
    if (automatic && !automaticEnabled()) throw new Error("automatic-check-disabled");
    if (checkFlight) await checkFlight;
    else {
      checkFlight = discover(automatic);
      try { await checkFlight; } finally { checkFlight = null; }
    }
    return status();
  }

  async function install(): Promise<LiveEngineerVoicePackStatus> {
    if (!featureEnabled()) throw new Error("feature-disabled");
    if (installing) throw new Error("install-in-progress");
    installing = true;
    installFlight = (async () => {
      let temporary: string | null = null;
      try {
        const current = await status();
        const shouldInstallCandidate = current.updateAvailable && latest;
        if (current.state === "ready" && !shouldInstallCandidate) return current;
        const expectedVersion = shouldInstallCandidate ? latest!.packageVersion : LIVE_ENGINEER_AUDIO_PACKAGE.packageVersion;
        const metadataSha = shouldInstallCandidate ? latest!.sha256 : undefined;
        const url = shouldInstallCandidate ? latest!.archiveUrl : LIVE_ENGINEER_AUDIO_PACKAGE.downloadUrl;
        if (!featureEnabled()) throw new Error("feature-disabled");
        const response = await fetchImpl(url);
        if (!response.ok) throw new Error(`Voice package download failed (${response.status})`);
        temporary = await mkdtemp(join(tmpdir(), "raceiq-live-engineer-"));
        const archive = join(temporary, "package.zip");
        await downloadBoundedResponse(response, archive);
        await installPack(archive, dirname(dirname(root)), expectedVersion, metadataSha);
        const installedStatus = await status();
        if (installedStatus.state !== "ready" || installedStatus.installedVersion !== expectedVersion) throw new Error("Installed voice pack failed verification");
        updateError = null;
        return installedStatus;
      } catch (error) {
        updateError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        try {
          if (temporary) await rm(temporary, { recursive: true, force: true });
        } finally {
          installing = false;
          broadcast({ type: "live-engineer-package-update" });
        }
      }
    })();
    try { await installFlight; } finally { installFlight = null; }
    return status();
  }

  return {
    getStatus: status,
    check: () => check(false),
    checkAutomatic: () => check(true),
    install,
    isInstalling: () => installing,
    startAutomaticChecks(): () => void {
      let stopped = false;
      const run = async () => {
        if (stopped || !featureEnabled() || !automaticEnabled()) return;
        try { await check(true); } catch { /* gated automatic check has no remote side effect */ }
      };
      const startup = timers.setTimeout(() => { void run(); }, START_DELAY_MS);
      const interval = timers.setInterval(() => { void run(); }, INTERVAL_MS);
      if (typeof startup === "object" && startup !== null && "unref" in startup && typeof startup.unref === "function") startup.unref();
      if (typeof interval === "object" && interval !== null && "unref" in interval && typeof interval.unref === "function") interval.unref();
      return () => { stopped = true; timers.clearTimeout(startup); timers.clearInterval(interval); };
    },
  };
}
