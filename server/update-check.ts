import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import pkg from "../package.json";
import { wsManager } from "./ws";

const VERSION = pkg.version;
const GITHUB_REPO = "SpeedHQ/RaceIQ";
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

interface UpdateState {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null;
  checked: boolean;
}

let state: UpdateState = {
  current: VERSION,
  latest: null,
  updateAvailable: false,
  downloadUrl: null,
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
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "User-Agent": `raceiq/${VERSION}` } },
    );
    if (!res.ok) return { ...state, checked: true };

    const data = await res.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const latest = data.tag_name.replace(/^v/, "");
    const updateAvailable = isNewer(latest, VERSION);

    const zipAsset = data.assets.find((a) => a.name.match(/raceiq-v.*-windows-x64\.zip$/));
    const downloadUrl = zipAsset?.browser_download_url ?? null;

    state = { current: VERSION, latest, updateAvailable, downloadUrl, checked: true };

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
  // Delay startup check by 10s to not compete with server init
  setTimeout(() => checkForUpdate(), 10_000);
  setInterval(() => checkForUpdate(), FOUR_HOURS_MS);
}

/** Downloads and applies an update. Spawns an elevated PS1 swap script, then exits. */
export async function applyUpdate(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Auto-update is only supported on Windows");
  }
  if (!state.updateAvailable || !state.downloadUrl || !state.latest) {
    throw new Error("No update available");
  }

  const version = state.latest;
  const downloadUrl = state.downloadUrl;
  const tmpDir = tmpdir();
  const zipPath = join(tmpDir, `raceiq-update-v${version}.zip`);
  const stagingDir = join(tmpDir, `raceiq-update-v${version}`);
  const installDir = dirname(process.execPath);
  const pid = process.pid;

  // Download the ZIP
  console.log(`[Update] Downloading v${version} from ${downloadUrl}`);
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  writeFileSync(zipPath, Buffer.from(buffer));
  console.log(`[Update] Downloaded to ${zipPath}`);

  // Write the elevated swap script
  const swapScript = `
$installDir = '${installDir.replace(/\\/g, "\\\\")}'
$zipPath = '${zipPath.replace(/\\/g, "\\\\")}'
$stagingDir = '${stagingDir.replace(/\\/g, "\\\\")}'
$targetPid = ${pid}

# Wait for main process to exit (max 30s)
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  Start-Sleep -Milliseconds 500
}

# Extract ZIP to staging dir
if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $stagingDir -Force

# Rename old exe (can rename a running exe on Windows)
$oldExe = Join-Path $installDir 'raceiq.exe'
$oldExeBackup = Join-Path $installDir 'raceiq.exe.old'
if (Test-Path $oldExeBackup) { Remove-Item $oldExeBackup -Force -ErrorAction SilentlyContinue }
Rename-Item -Path $oldExe -NewName 'raceiq.exe.old' -Force -ErrorAction SilentlyContinue

# Copy new files over install dir
Copy-Item -Path (Join-Path $stagingDir '*') -Destination $installDir -Recurse -Force

# Launch new exe
Start-Process (Join-Path $installDir 'raceiq.exe')

# Cleanup
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
`.trimStart();

  const swapScriptPath = join(tmpDir, `raceiq-swap-v${version}.ps1`);
  writeFileSync(swapScriptPath, swapScript, "utf8");

  // Spawn the script elevated (triggers UAC prompt)
  spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${swapScriptPath.replace(/\\/g, "\\\\")}\\"'`,
    ],
    { stdio: "ignore", detached: true, windowsHide: true },
  ).unref();

  console.log(`[Update] Swap script spawned elevated. Exiting...`);
  // Small delay so the response can be sent before we exit
  setTimeout(() => process.exit(0), 500);
}

/** Delete raceiq.exe.old if left over from a previous update. */
export function cleanupOldExe(): void {
  const oldExe = join(dirname(process.execPath), "raceiq.exe.old");
  if (existsSync(oldExe)) {
    try {
      unlinkSync(oldExe);
      console.log("[Update] Cleaned up raceiq.exe.old");
    } catch {}
  }
}
