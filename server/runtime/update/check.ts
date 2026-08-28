import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import pkg from "../../../package.json";
import { wsManager } from "../websocket-manager";
import { isNewer } from "./version";
import { IS_WINDOWS } from "../platform/shell";
import { ROOT_DIR } from "../config/paths";
export { isNewer };

const VERSION = pkg.version;
const GITHUB_REPO = "SpeedHQ/RaceIQ";
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Dev/test overrides:
// LOCAL_INSTALLER=path/to/RaceIQ-Setup.exe — skip download, use local installer
// DEV_FORCE_UPDATE=1 — pretend an update is available (version 99.0.0)

function findLocalInstaller(): string | undefined {
  if (process.env.LOCAL_INSTALLER) return process.env.LOCAL_INSTALLER;
  if (process.env.NODE_ENV === "production") return undefined;
  try {
    const match = readdirSync(ROOT_DIR).find((f) => /^RaceIQ-Setup.*\.exe$/.test(f));
    if (match) {
      const fullPath = join(ROOT_DIR, match);
      console.log(`[Update] Dev mode: found local installer ${fullPath}`);
      return fullPath;
    }
  } catch {}
  return undefined;
}

const LOCAL_INSTALLER = findLocalInstaller();
const DEV_FORCE_UPDATE = process.env.DEV_FORCE_UPDATE === "1" || !!LOCAL_INSTALLER;

interface ReleaseInfo {
  version: string;
  notes: string;
  date: string;
}

interface UpdateState {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null;
  /** All releases newer than current version */
  newReleases: ReleaseInfo[];
  /** Deprecated compatibility field; release history now comes from API bodies. */
  fullReleaseNotes: string | null;
  currentReleaseNotes: string | null;
  currentReleaseDate: string | null;
  lastChecked: string | null;
  checked: boolean;
}

let state: UpdateState = {
  current: VERSION,
  latest: null,
  updateAvailable: false,
  downloadUrl: null,
  newReleases: [],
  fullReleaseNotes: null,
  currentReleaseNotes: null,
  currentReleaseDate: null,
  lastChecked: null,
  checked: false,
};

// Tag associated with the release-note data held in `state`.
let releaseArtifactsTag: string | null = null;

// Release metadata and bodies are fetched only when latest tag changes.
export function shouldFetchReleaseArtifacts(cachedTag: string | null, latestTag: string): boolean {
  return cachedTag !== latestTag;
}

// Path to the tray command file (server writes, tray polls)
let trayCommandFile: string | null = null;


export function setTrayCommandFile(path: string): void {
  trayCommandFile = path;
}

export function getUpdateState(): UpdateState {
  return state;
}

const GH_HEADERS = { "User-Agent": `raceiq/${VERSION}` };

function notifyUpdateAvailable(version: string): void {
  wsManager.broadcastNotification({ type: "update-available", version });
  if (trayCommandFile) {
    try {
      writeFileSync(trayCommandFile, `update-available:${version}`);
    } catch {}
  }
}

interface GitHubRelease {
  tag_name: string;
  body?: string | null;
  published_at?: string;
  assets: { name: string; browser_download_url: string }[];
}

export function getReleaseNotes(release: GitHubRelease): string | null {
  const body = release.body?.trim();
  return body || null;
}

export function collectReleaseNotes(releases: GitHubRelease[], currentVersion: string): {
  newReleases: ReleaseInfo[];
  currentReleaseNotes: string | null;
  currentReleaseDate: string | null;
} {
  const newReleases: ReleaseInfo[] = [];
  let currentReleaseNotes: string | null = null;
  let currentReleaseDate: string | null = null;

  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, "");
    if (version !== currentVersion && !isNewer(version, currentVersion)) continue;
    const notes = getReleaseNotes(release);
    if (version === currentVersion) {
      currentReleaseNotes = notes;
      currentReleaseDate = release.published_at ?? null;
    } else if (notes) {
      newReleases.push({ version, notes, date: release.published_at ?? "" });
    }
  }

  return { newReleases, currentReleaseNotes, currentReleaseDate };
}

/** Fetch all releases from GitHub and split into new/current. */
export function mergeLatestRelease(releases: GitHubRelease[], latest?: GitHubRelease): GitHubRelease[] {
  if (!latest || releases.some((release) => release.tag_name === latest.tag_name)) return releases;
  return [latest, ...releases];
}

export async function fetchReleases(currentVersion: string, latest?: GitHubRelease): Promise<{
  newReleases: ReleaseInfo[];
  fullReleaseNotes: string | null;
  currentReleaseNotes: string | null;
  currentReleaseDate: string | null;
}> {
  const releases: GitHubRelease[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50&page=${page}`, { headers: GH_HEADERS });
    if (!res.ok) throw new Error(`Release list fetch failed: ${res.status}`);
    const pageReleases = await res.json() as GitHubRelease[];
    releases.push(...pageReleases);
    if (pageReleases.length < 50) break;
  }

  const mergedReleases = mergeLatestRelease(releases, latest);
  return { ...collectReleaseNotes(mergedReleases, currentVersion), fullReleaseNotes: null };
}


export async function checkForUpdate(): Promise<UpdateState> {
  // Dev mode: fake an available update using a local installer, but fetch real release notes
  if (DEV_FORCE_UPDATE) {
    const fakeVersion = "99.0.0";
    const { newReleases, fullReleaseNotes, currentReleaseNotes, currentReleaseDate } = await fetchReleases(VERSION).catch(() => ({ newReleases: [] as ReleaseInfo[], fullReleaseNotes: null, currentReleaseNotes: null, currentReleaseDate: null }));
    const lastChecked = new Date().toISOString();
    state = { current: VERSION, latest: fakeVersion, updateAvailable: true, downloadUrl: LOCAL_INSTALLER ?? null, newReleases, fullReleaseNotes, currentReleaseNotes, currentReleaseDate, lastChecked, checked: true };
    notifyUpdateAvailable(fakeVersion);
    console.log(`[Update] DEV_FORCE_UPDATE: faking update to v${fakeVersion}${LOCAL_INSTALLER ? ` (local: ${LOCAL_INSTALLER})` : ""}`);
    return state;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: GH_HEADERS },
    );
    if (!res.ok) return { ...state, checked: true };

    const data = await res.json() as GitHubRelease;
    const latest = data.tag_name.replace(/^v/, "");
    const updateAvailable = isNewer(latest, VERSION);

    const installerAsset = data.assets.find((a) => a.name.match(/RaceIQ-Setup-v.*\.exe$/));
    const downloadUrl = installerAsset?.browser_download_url ?? null;

    let releaseData = {
      newReleases: state.newReleases,
      fullReleaseNotes: state.fullReleaseNotes,
      currentReleaseNotes: state.currentReleaseNotes,
      currentReleaseDate: state.currentReleaseDate,
    };
    if (shouldFetchReleaseArtifacts(releaseArtifactsTag, latest)) {
      releaseData = await fetchReleases(VERSION, data);
      releaseArtifactsTag = latest;
    }

    const { newReleases, fullReleaseNotes, currentReleaseNotes, currentReleaseDate } = releaseData;

    const lastChecked = new Date().toISOString();
    state = { current: VERSION, latest, updateAvailable, downloadUrl, newReleases, fullReleaseNotes, currentReleaseNotes, currentReleaseDate, lastChecked, checked: true };

    if (updateAvailable) {
      notifyUpdateAvailable(latest);
    }
  } catch {
    state = { ...state, checked: true };
  }
  return state;
}

export function startUpdateCheckSchedule(): void {
  if (DEV_FORCE_UPDATE) {
    // Dev mode: check immediately so release notes are available on first load
    checkForUpdate();
  } else {
    // Delay startup check by 10s to not compete with server init. `.unref()`
    // so `bun test` can exit — misc-routes.ts calls this at module load, and
    // without unref every test that transitively imports routes hangs for 10s
    // plus the GitHub fetch round-trip.
    const t = setTimeout(() => checkForUpdate(), 10_000);
    t.unref?.();
  }
  const i = setInterval(() => checkForUpdate(), FOUR_HOURS_MS);
  i.unref?.();
}

/** Downloads the Inno Setup installer and runs it silently. Inno handles process kill, file swap, registry update, and relaunch. */
export async function applyUpdate(): Promise<void> {
  if (!IS_WINDOWS) {
    throw new Error("Auto-update is only supported on Windows");
  }
  if (!state.updateAvailable || !state.latest) {
    throw new Error("No update available");
  }

  const version = state.latest;
  let installerPath: string;

  // Local installer path — skip download entirely
  if (LOCAL_INSTALLER) {
    installerPath = resolve(LOCAL_INSTALLER);
    if (!existsSync(installerPath)) {
      throw new Error(`Local installer not found: ${installerPath}`);
    }
    console.log(`[Update] Using local installer: ${installerPath}`);

    // Simulate download progress for UI testing (~2s total)
    wsManager.broadcastNotification({ type: "update-progress", stage: "downloading", percent: 0 });
    for (let p = 10; p <= 100; p += 10) {
      await new Promise((r) => setTimeout(r, 200));
      wsManager.broadcastNotification({ type: "update-progress", stage: "downloading", percent: p });
    }
  } else {
    // Download from GitHub
    if (!state.downloadUrl) throw new Error("No download URL available");
    const downloadUrl = state.downloadUrl;
    installerPath = join(tmpdir(), `RaceIQ-Setup-v${version}.exe`);

    console.log(`[Update] Downloading installer v${version} from ${downloadUrl}`);
    wsManager.broadcastNotification({ type: "update-progress", stage: "downloading", percent: 0 });

    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const contentLength = Number(res.headers.get("content-length") || 0);
    const body = res.body;

    if (!body || !contentLength) {
      const buffer = await res.arrayBuffer();
      writeFileSync(installerPath, Buffer.from(buffer));
    } else {
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastBroadcast = 0;

      for await (const chunk of body) {
        chunks.push(chunk);
        received += chunk.length;
        const percent = Math.round((received / contentLength) * 100);
        if (percent >= lastBroadcast + 5 || percent === 100) {
          lastBroadcast = percent;
          wsManager.broadcastNotification({ type: "update-progress", stage: "downloading", percent });
        }
      }

      const buffer = Buffer.concat(chunks);
      writeFileSync(installerPath, buffer);
    }

    console.log(`[Update] Downloaded to ${installerPath}`);
  }

  wsManager.broadcastNotification({ type: "update-progress", stage: "installing", percent: 100 });

  // Run the installer silently — Inno Setup handles:
  // - Killing the running process (PrepareToInstall in .iss)
  // - Swapping all files in the install directory
  // - Updating Windows registry (Apps & Features version)
  // - Relaunching the app (postinstall Run section)
  console.log(`[Update] Spawning installer: ${installerPath}`);
  spawn(installerPath, ["/SILENT", "/NORESTART"], {
    stdio: "ignore",
    detached: true,
  }).unref();

  console.log(`[Update] Installer spawned. Process will be killed by Inno Setup.`);
  // Small delay so the HTTP response can be sent before Inno kills us
  setTimeout(() => process.exit(0), 500);
}
