# Windows Installer & Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proper Windows installer (Inno Setup) and a fully-featured in-app auto-updater that checks GitHub Releases, notifies via tray + browser, and applies updates by swapping files in-place.

**Architecture:** `server/update-check.ts` already exists with a basic check skeleton — extend it with semver comparison, download URL tracking, WS broadcast, tray IPC, and `applyUpdate()`. A new `server/data-dir.ts` helper auto-detects the data dir when running from Program Files. The client shows update state in a new Settings > Updates section and a global dismissible banner.

**Tech Stack:** Bun, Hono RPC, Zustand, Inno Setup (installer script), PowerShell (elevated file swap + tray IPC), GitHub Releases API.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/data-dir.ts` | `resolveDataDir()` — auto-detects AppData when running from Program Files |
| Modify | `server/db/index.ts` | Import resolveDataDir instead of reading env var directly |
| Modify | `server/settings.ts` | Import resolveDataDir instead of reading env var directly |
| Modify | `server/update-check.ts` | Fix repo, semver, download URL, WS broadcast, tray notify, `applyUpdate()` |
| Modify | `server/ws.ts` | Add `broadcastNotification(payload)` method |
| Modify | `server/tray.ts` | Add WinForms Timer to poll a command file for server→tray IPC |
| Modify | `server/routes/misc-routes.ts` | Add `POST /api/update/check` and `POST /api/update/apply` |
| Modify | `client/src/stores/telemetry.ts` | Add `updateAvailable` state |
| Modify | `client/src/hooks/useWebSocket.ts` | Handle `type === "update-available"` WS message |
| Modify | `client/src/components/Settings.tsx` | Add "Updates" nav item + `UpdatesSection` component |
| Create | `installer/raceiq.iss` | Inno Setup installer script |
| Modify | `.github/workflows/release.yml` | Add `iscc` build + upload step |
| Create | `test/update-check.test.ts` | Unit tests for semver comparison |

---

## Task 1: Add resolveDataDir() helper

**Files:**
- Create: `server/data-dir.ts`

- [ ] **Step 1: Create the module**

```typescript
// server/data-dir.ts
import { join } from "path";
import { homedir } from "os";

/**
 * Resolves the data directory for RaceIQ.
 * When running from Program Files (installed), uses %APPDATA%\RaceIQ.
 * When running from anywhere else (dev/portable), uses DATA_DIR env var or ./data.
 */
export function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const execPath = process.execPath.toLowerCase();
  if (execPath.includes("program files")) {
    return join(process.env.APPDATA ?? homedir(), "RaceIQ");
  }
  return "./data";
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/update-check.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("resolveDataDir", () => {
  let originalDataDir: string | undefined;
  let originalExecPath: string;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    originalExecPath = process.execPath;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  test("returns DATA_DIR env var when set", async () => {
    process.env.DATA_DIR = "/custom/path";
    const { resolveDataDir } = await import("../server/data-dir");
    expect(resolveDataDir()).toBe("/custom/path");
  });

  test("returns ./data when not in Program Files and no env var", async () => {
    delete process.env.DATA_DIR;
    const { resolveDataDir } = await import("../server/data-dir");
    // In test, execPath won't contain "program files"
    expect(resolveDataDir()).toBe("./data");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test test/update-check.test.ts
```

Expected: FAIL (module doesn't exist yet — file was just created, so it should pass now; if not, check import path)

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/update-check.test.ts
```

Expected: 2 tests PASS

- [ ] **Step 5: Update `server/db/index.ts` to use resolveDataDir**

Change the top of the file — replace the `DATA_DIR` line:

```typescript
// Add this import at the top (after existing imports):
import { resolveDataDir } from "../data-dir";

// Replace:
// const DB_DIR = process.env.DATA_DIR ?? "./data";
// With:
const DB_DIR = resolveDataDir();
```

- [ ] **Step 6: Update `server/settings.ts` to use resolveDataDir**

```typescript
// Add this import at the top:
import { resolveDataDir } from "./data-dir";

// Replace:
// const SETTINGS_DIR = process.env.DATA_DIR ?? "./data";
// With:
const SETTINGS_DIR = resolveDataDir();
```

- [ ] **Step 7: Commit**

```bash
git add server/data-dir.ts server/db/index.ts server/settings.ts test/update-check.test.ts
git commit -m "feat: auto-detect data dir when running from Program Files"
```

---

## Task 2: Add broadcastNotification to WebSocket manager

**Files:**
- Modify: `server/ws.ts`

- [ ] **Step 1: Add the method to WebSocketManager class**

Add after the `broadcastStatus` method (around line 106):

```typescript
/**
 * Broadcast an arbitrary JSON notification to all connected clients.
 * Used for update-available and other server-initiated events.
 */
broadcastNotification(payload: Record<string, unknown>): void {
  if (this.clients.size === 0) return;
  const json = JSON.stringify(payload);
  for (const client of this.clients) {
    try { client.send(json); } catch {}
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/ws.ts
git commit -m "feat: add broadcastNotification to WebSocket manager"
```

---

## Task 3: Extend server/update-check.ts

**Files:**
- Modify: `server/update-check.ts`

This task rewrites the file substantially. The existing file has the right skeleton but wrong repo, daily interval, no download URL, no WS broadcast, no tray IPC, and no apply logic.

- [ ] **Step 1: Write tests for semver comparison**

Add to `test/update-check.test.ts`:

```typescript
describe("isNewer", () => {
  // We'll test the exported function after the rewrite
  test("1.2.3 is newer than 1.2.2", async () => {
    const { isNewer } = await import("../server/update-check");
    expect(isNewer("1.2.3", "1.2.2")).toBe(true);
  });

  test("1.3.0 is newer than 1.2.9", async () => {
    const { isNewer } = await import("../server/update-check");
    expect(isNewer("1.3.0", "1.2.9")).toBe(true);
  });

  test("2.0.0 is newer than 1.9.9", async () => {
    const { isNewer } = await import("../server/update-check");
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  test("same version is not newer", async () => {
    const { isNewer } = await import("../server/update-check");
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  test("older version is not newer", async () => {
    const { isNewer } = await import("../server/update-check");
    expect(isNewer("1.2.1", "1.2.3")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
bun test test/update-check.test.ts
```

Expected: FAIL — `isNewer` is not exported

- [ ] **Step 3: Rewrite server/update-check.ts**

```typescript
import { writeFileSync, unlinkSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { tmpdir, homedir } from "os";
import { spawn } from "child_process";
import pkg from "../package.json";
import { wsManager } from "./ws";

const VERSION = pkg.version;
const GITHUB_REPO = "Snazzie/RaceIQ";
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  downloadUrl: string;
}

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
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${swapScriptPath}\\"'`,
    ],
    { stdio: "ignore", detached: true },
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/update-check.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/update-check.ts test/update-check.test.ts
git commit -m "feat: extend update-check with semver, apply, tray IPC, WS broadcast"
```

---

## Task 4: Update tray for bidirectional IPC

**Files:**
- Modify: `server/tray.ts`

The tray PS1 currently has no way to receive commands from the server. We add a WinForms Timer that polls a temp command file every 5 seconds. The server writes to this file to trigger notifications and menu item visibility.

- [ ] **Step 1: Update startTray to return the command file path and add IPC polling**

Replace the contents of `server/tray.ts` with:

```typescript
import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setTrayCommandFile } from "./update-check";

export function startTray(port: number): void {
  if (process.platform !== "win32") return;

  const commandFile = join(tmpdir(), `raceiq-tray-cmd-${process.pid}.txt`).replace(/\\/g, "\\\\");

  // Tell update-check where to write tray commands
  setTrayCommandFile(commandFile.replace(/\\\\/g, "\\"));

  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$port = ${port}
$url = "http://localhost:$port"
$cmdFile = '${commandFile}'

# Draw a 32x32 RaceIQ icon: dark circle + cyan checkered motif
$sz = 32
$bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 2, 6, 23))
$g.FillEllipse($bgBrush, 0, 0, $sz - 1, $sz - 1)
$cyanFull = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 211, 238))
$cyanDim  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(51, 34, 211, 238))
$g.FillRectangle($cyanFull, 8, 8, 8, 8)
$g.FillRectangle($cyanDim,  16, 8, 8, 8)
$g.FillRectangle($cyanDim,  8, 16, 8, 8)
$g.FillRectangle($cyanFull, 16, 16, 8, 8)
$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(89, 34, 211, 238), 1.0)
$g.DrawEllipse($ringPen, 0.5, 0.5, $sz - 2, $sz - 2)
$g.Dispose()
$iconHandle = $bmp.GetHicon()
$raceiqIcon = [System.Drawing.Icon]::FromHandle($iconHandle)
$bmp.Dispose()

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $raceiqIcon
$tray.Text = "RaceIQ"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open RaceIQ"
$openItem.add_Click({ Start-Process $url })
$menu.Items.Add($openItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$updateItem = New-Object System.Windows.Forms.ToolStripMenuItem
$updateItem.Text = "Install Update"
$updateItem.Visible = $false
$updateItem.add_Click({
  try {
    Invoke-WebRequest -Uri "http://localhost:${port}/api/update/apply" -Method POST -UseBasicParsing | Out-Null
  } catch {}
})
$menu.Items.Add($updateItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit"
$exitItem.add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($exitItem) | Out-Null

$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Start-Process $url })

# Poll command file every 5s for server->tray IPC
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if (Test-Path $cmdFile) {
    try {
      $cmd = (Get-Content $cmdFile -Raw).Trim()
      Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
      if ($cmd -match '^update-available:(.+)$') {
        $ver = $matches[1]
        $updateItem.Text = "Install Update (v$ver)"
        $updateItem.Visible = $true
        $tray.BalloonTipTitle = "RaceIQ Update Available"
        $tray.BalloonTipText = "RaceIQ v$ver is available. Click to install."
        $tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $tray.ShowBalloonTip(5000)
      }
    } catch {}
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
`.trimStart();

  const tmpScript = join(tmpdir(), `raceiq-tray-${process.pid}.ps1`);

  try {
    writeFileSync(tmpScript, script, "utf8");
  } catch {
    return;
  }

  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", tmpScript],
    { stdio: "ignore", detached: false },
  );

  const cleanup = () => {
    try { unlinkSync(tmpScript); } catch {}
    try { unlinkSync(commandFile.replace(/\\\\/g, "\\")); } catch {}
  };

  proc.on("exit", (code) => {
    cleanup();
    if (code === 0) process.exit(0);
  });

  proc.on("error", cleanup);

  process.on("exit", () => {
    try { proc.kill(); } catch {}
    cleanup();
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add server/tray.ts
git commit -m "feat: add bidirectional tray IPC for update notifications"
```

---

## Task 5: Add update API routes to misc-routes

**Files:**
- Modify: `server/routes/misc-routes.ts`

- [ ] **Step 1: Add the imports and routes**

Add the import at the top of `misc-routes.ts` (the existing import for `getUpdateState` and `startUpdateCheckSchedule` is already there — extend it):

```typescript
// Change existing import line from:
import { getUpdateState, startUpdateCheckSchedule } from "../update-check";
// To:
import { getUpdateState, startUpdateCheckSchedule, checkForUpdate, applyUpdate } from "../update-check";
```

Add two new routes after the existing `GET /api/version` route:

```typescript
  // POST /api/update/check — force a fresh update check and return result
  .post("/api/update/check", async (c) => {
    const result = await checkForUpdate();
    return c.json(result);
  })

  // POST /api/update/apply — download and apply the pending update, then restart
  .post("/api/update/apply", async (c) => {
    try {
      applyUpdate(); // starts async; process will exit
      return new Response(null, { status: 204 });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  })
```

- [ ] **Step 2: Call cleanupOldExe on startup**

In `misc-routes.ts`, add to the imports and call it once:

```typescript
import { getUpdateState, startUpdateCheckSchedule, checkForUpdate, applyUpdate, cleanupOldExe } from "../update-check";

// Add after startUpdateCheckSchedule():
cleanupOldExe();
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/misc-routes.ts
git commit -m "feat: add POST /api/update/check and POST /api/update/apply routes"
```

---

## Task 6: Handle update-available in the client

**Files:**
- Modify: `client/src/stores/telemetry.ts`
- Modify: `client/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Add updateAvailable state to telemetry store**

In `client/src/stores/telemetry.ts`, add to the `TelemetryState` interface (after `isRaceOn`):

```typescript
/** Version string if a server update is available, null otherwise */
updateAvailable: string | null;
setUpdateAvailable: (version: string | null) => void;
```

Add to the initial state in `create<TelemetryState>((set, get) => ({`:

```typescript
updateAvailable: null,
setUpdateAvailable: (version) => set({ updateAvailable: version }),
```

- [ ] **Step 2: Handle the WS message in useWebSocket**

In `client/src/hooks/useWebSocket.ts`, destructure `setUpdateAvailable` from the store:

```typescript
const { setConnected, setPacket, setSectors, setPit, setPacketsPerSec, setUdpStatus, setUpdateAvailable } = useTelemetryStore();
```

In the `ws.onmessage` handler, add a case for the new message type. Change:

```typescript
if (data.type === "status") {
  setUdpStatus(data.udpPps, data.isRaceOn);
} else {
```

To:

```typescript
if (data.type === "status") {
  setUdpStatus(data.udpPps, data.isRaceOn);
} else if (data.type === "update-available") {
  setUpdateAvailable(data.version as string);
} else {
```

Also update the dependency array of `useCallback` to include `setUpdateAvailable`:

```typescript
}, [setConnected, setPacket, setSectors, setPit, setUdpStatus, setUpdateAvailable]);
```

- [ ] **Step 3: Commit**

```bash
git add client/src/stores/telemetry.ts client/src/hooks/useWebSocket.ts
git commit -m "feat: handle update-available WS message in client"
```

---

## Task 7: Add Updates section to Settings

**Files:**
- Modify: `client/src/components/Settings.tsx`

- [ ] **Step 1: Add "Updates" to NAV_ITEMS**

Find the `NAV_ITEMS` const and add the updates item before "about":

```typescript
const NAV_ITEMS = [
  { id: "theme", label: "Theme" },
  { id: "connection", label: "Connection" },
  { id: "wheel", label: "Wheel" },
  { id: "temperature", label: "Temperature" },
  { id: "tireHealth", label: "Tire Health" },
  { id: "suspension", label: "Suspension" },
  { id: "speed", label: "Units" },
  { id: "sound", label: "Sound" },
  { id: "extraction", label: "Extraction" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;
```

- [ ] **Step 2: Add the UpdatesSection component**

Add the following component to `Settings.tsx`, before the main `Settings` export function. This component uses local state only (no Zustand) since it's a one-off action panel.

```typescript
function UpdatesSection() {
  const updateAvailable = useTelemetryStore((s) => s.updateAvailable);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checked: boolean;
  } | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await client.api.update.check.$post();
      setCheckResult(await res.json() as any);
    } catch {
      setCheckResult(null);
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    setApplying(true);
    try {
      await client.api.update.apply.$post();
    } catch {
      setApplying(false);
    }
    // If apply succeeds, the server exits — app will reconnect after restart
  };

  const showUpdate = checkResult?.updateAvailable || updateAvailable;
  const latestVersion = checkResult?.latest ?? updateAvailable;
  const currentVersion = checkResult?.current;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-app-text">Updates</h3>
        {currentVersion && (
          <p className="text-sm text-app-text-muted mt-1">
            Current version: <span className="text-app-text font-mono">{currentVersion}</span>
          </p>
        )}
      </div>

      {showUpdate && latestVersion && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3">
          <p className="text-sm font-medium text-app-accent">
            Update available: v{latestVersion}
          </p>
          <div className="flex gap-3">
            <Button
              onClick={handleInstall}
              disabled={applying}
              className="bg-app-accent text-black hover:bg-app-accent/90"
            >
              {applying ? "Installing..." : "Install Update"}
            </Button>
            <Button variant="outline" onClick={() => setCheckResult(null)}>
              Later
            </Button>
          </div>
          {applying && (
            <p className="text-xs text-app-text-muted">
              RaceIQ will restart after installing. This page may briefly disconnect.
            </p>
          )}
        </div>
      )}

      {checkResult && !checkResult.updateAvailable && (
        <p className="text-sm text-app-text-muted">
          You&apos;re on the latest version ({checkResult.current}).
        </p>
      )}

      <Button onClick={handleCheck} disabled={checking} variant="outline">
        {checking ? "Checking..." : "Check for Updates"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Add the useTelemetryStore import if not already present**

Check the imports at the top of `Settings.tsx`. If `useTelemetryStore` is not already imported, add:

```typescript
import { useTelemetryStore } from "../stores/telemetry";
```

- [ ] **Step 4: Wire the section into the Settings render**

Find the `{activeSection === "about" && (` block (around line 1211). Add the updates case immediately before it:

```typescript
        {activeSection === "updates" && (
          <UpdatesSection />
        )}
        {activeSection === "about" && (
          <AboutSection />
        )}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Settings.tsx
git commit -m "feat: add Updates section to Settings with check and install buttons"
```

---

## Task 8: Create Inno Setup installer script

**Files:**
- Create: `installer/raceiq.iss`

- [ ] **Step 1: Create the installer directory and script**

```ini
; installer/raceiq.iss
; Compile with: iscc /DMyAppVersion=1.0.0 installer\raceiq.iss

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "RaceIQ"
#define MyAppPublisher "Snazzie"
#define MyAppURL "https://github.com/Snazzie/RaceIQ"
#define MyAppExeName "raceiq.exe"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={commonpf64}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputBaseFilename=RaceIQ-Setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; Upgrade: remove old files before installing new ones
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\raceiq.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\shared\*"; DestDir: "{app}\shared"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-Command ""Get-Process raceiq -ErrorAction SilentlyContinue | Stop-Process -Force"""; Flags: runhidden
```

- [ ] **Step 2: Commit**

```bash
git add installer/raceiq.iss
git commit -m "feat: add Inno Setup installer script"
```

---

## Task 9: Update CI release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add installer build and upload to the `build` job**

Find the `build` job in `release.yml`. After the existing `Package` step and before the `upload-artifact` step, add:

```yaml
      - name: Build installer
        shell: cmd
        run: |
          SET VERSION=${{ needs.compute-version.outputs.version }}
          iscc /DMyAppVersion=%VERSION% installer\raceiq.iss

      - uses: actions/upload-artifact@v4
        with:
          name: raceiq-v${{ needs.compute-version.outputs.version }}-setup
          path: RaceIQ-Setup-v${{ needs.compute-version.outputs.version }}.exe
```

Also update the `draft-release` job's artifact pattern to pick up both the ZIP and installer:

The existing `pattern: raceiq-v*` in the `download-artifact` step will already match both artifact names (`raceiq-v*-windows-x64` and `raceiq-v*-setup`), so no change needed there.

- [ ] **Step 2: Verify the workflow file looks correct**

Open `.github/workflows/release.yml` and confirm the build job now has:
1. The existing `Package` step (7z into ZIP)
2. The existing ZIP `upload-artifact` step
3. The new `Build installer` step
4. The new installer `upload-artifact` step

Both the ZIP and installer EXE will be attached to the GitHub Release.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: build and upload Inno Setup installer in release workflow"
```

---

## Task 10: Verify full build still works

- [ ] **Step 1: Run tests**

```bash
bun test
```

Expected: All tests pass (including the new semver and resolveDataDir tests)

- [ ] **Step 2: Run dev build to verify server starts**

```bash
bun run dev:server
```

Expected: Server starts on port 3117, no import errors

- [ ] **Step 3: Run client build**

```bash
cd client && bun run build
```

Expected: Build completes with no TypeScript errors

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: resolve any build issues from installer/updater integration"
```
