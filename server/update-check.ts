import { writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawn } from "child_process";
import pkg from "../package.json";
import { wsManager } from "./ws";

const VERSION = pkg.version;
const GITHUB_REPO = "SpeedHQ/RaceIQ";
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Dev/test overrides:
// LOCAL_INSTALLER=path/to/RaceIQ-Setup.exe — skip download, use local installer
// DEV_FORCE_UPDATE=1 — pretend an update is available (version 99.0.0)
// In dev mode, auto-detect installer in project root (e.g. RaceIQ-Setup-v0.3.2.exe)
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findLocalInstaller(): string | undefined {
  if (process.env.LOCAL_INSTALLER) return process.env.LOCAL_INSTALLER;
  if (process.env.NODE_ENV === "production") return undefined;
  try {
    const match = readdirSync(PROJECT_ROOT).find((f) => /^RaceIQ-Setup.*\.exe$/.test(f));
    if (match) {
      const fullPath = join(PROJECT_ROOT, match);
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
  currentReleaseNotes: null,
  currentReleaseDate: null,
  lastChecked: null,
  checked: false,
};

// Path to the tray command file (server writes, tray polls)
let trayCommandFile: string | null = null;

export function setTrayCommandFile(path: string): void {
  trayCommandFile = path;
}

export function getUpdateState(): UpdateState {
  return state;
}

const GH_HEADERS = { "User-Agent": `raceiq/${VERSION}` };

interface GitHubRelease {
  tag_name: string;
  body?: string;
  published_at?: string;
  assets: { name: string; browser_download_url: string }[];
}

/** Strip GitHub auto-generated boilerplate from release notes. */
function cleanReleaseNotes(body: string): string {
  return body
    .replace(/^#+\s*What's Changed\s*\n*/im, "")
    .replace(/\n*\*\*Full Changelog\*\*:.*$/im, "")
    .trim();
}

/** Fetch all releases from GitHub and split into new/current. */
async function fetchReleases(currentVersion: string): Promise<{
  newReleases: ReleaseInfo[];
  currentReleaseNotes: string | null;
  currentReleaseDate: string | null;
}> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50`, { headers: GH_HEADERS });
  if (!res.ok) return { newReleases: [], currentReleaseNotes: null, currentReleaseDate: null };

  const releases = await res.json() as GitHubRelease[];
  const newReleases: ReleaseInfo[] = [];
  let currentReleaseNotes: string | null = null;
  let currentReleaseDate: string | null = null;

  for (const r of releases) {
    const ver = r.tag_name.replace(/^v/, "");
    const notes = r.body?.trim() ? cleanReleaseNotes(r.body.trim()) : null;
    if (ver === currentVersion) {
      currentReleaseNotes = notes;
      currentReleaseDate = r.published_at ?? null;
    } else if (isNewer(ver, currentVersion)) {
      if (notes) {
        newReleases.push({ version: ver, notes, date: r.published_at ?? "" });
      }
    }
  }

  return { newReleases, currentReleaseNotes, currentReleaseDate };
}

/** Returns true if version string `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [am, an, ap] = parse(a);
  const [bm, bn, bp] = parse(b);
  if (am !== bm) return am > bm;
  if (an !== bn) return an > bn;
  return ap > bp;
}

export async function checkForUpdate(): Promise<UpdateState> {
  // Dev mode: fake an available update using a local installer, but fetch real release notes
  if (DEV_FORCE_UPDATE) {
    const fakeVersion = "99.0.0";
    const { newReleases, currentReleaseNotes, currentReleaseDate } = await fetchReleases(VERSION).catch(() => ({ newReleases: [] as ReleaseInfo[], currentReleaseNotes: null, currentReleaseDate: null }));
    const lastChecked = new Date().toISOString();
    state = { current: VERSION, latest: fakeVersion, updateAvailable: true, downloadUrl: LOCAL_INSTALLER ?? null, newReleases, currentReleaseNotes, currentReleaseDate, lastChecked, checked: true };
    wsManager.broadcastNotification({ type: "update-available", version: fakeVersion });
    if (trayCommandFile) {
      try { writeFileSync(trayCommandFile, `update-available:${fakeVersion}`); } catch {}
    }
    console.log(`[Update] DEV_FORCE_UPDATE: faking update to v${fakeVersion}${LOCAL_INSTALLER ? ` (local: ${LOCAL_INSTALLER})` : ""}`);
    return state;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "User-Agent": `raceiq/${VERSION}` } },
    );
    if (!res.ok) return { ...state, checked: true };

    const data = await res.json() as GitHubRelease;
    const latest = data.tag_name.replace(/^v/, "");
    const updateAvailable = isNewer(latest, VERSION);

    const installerAsset = data.assets.find((a) => a.name.match(/RaceIQ-Setup-v.*\.exe$/));
    const downloadUrl = installerAsset?.browser_download_url ?? null;

    const { newReleases, currentReleaseNotes, currentReleaseDate } = await fetchReleases(VERSION).catch(() => ({ newReleases: [] as ReleaseInfo[], currentReleaseNotes: null, currentReleaseDate: null }));

    const lastChecked = new Date().toISOString();
    state = { current: VERSION, latest, updateAvailable, downloadUrl, newReleases, currentReleaseNotes, currentReleaseDate, lastChecked, checked: true };

    if (updateAvailable) {
      // Notify browser clients via WebSocket
      wsManager.broadcastNotification({ type: "update-available", version: latest });
      // Notify tray via command file
      if (trayCommandFile) {
        try {
          writeFileSync(trayCommandFile, `update-available:${latest}`);
        } catch {}
      }
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
    // Delay startup check by 10s to not compete with server init
    setTimeout(() => checkForUpdate(), 10_000);
  }
  setInterval(() => checkForUpdate(), FOUR_HOURS_MS);
}

/** Downloads the Inno Setup installer and runs it silently. Inno handles process kill, file swap, registry update, and relaunch. */
export async function applyUpdate(): Promise<void> {
  if (process.platform !== "win32") {
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
