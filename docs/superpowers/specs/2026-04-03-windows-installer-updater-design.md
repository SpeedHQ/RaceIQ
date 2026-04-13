# Windows Installer & Updater Design

**Date:** 2026-04-03

## Overview

Add a proper Windows installer (Inno Setup) and an in-app auto-updater to RaceIQ. The installer produces a single `RaceIQ-Setup-vX.X.X.exe`, requires UAC elevation, and installs to `C:\Program Files\RaceIQ`. The updater runs inside the Bun server process, checks GitHub Releases on startup and every 4 hours, notifies via the system tray, and applies updates by swapping files in-place.

---

## Installer

### Tool

**Inno Setup** — free, well-documented, produces a single `.exe` installer. Pre-installed on GitHub-hosted Windows runners (`windows-2025`), so no additional CI setup is required.

### Script location

`installer/raceiq.iss`

### Install details

| Setting | Value |
|---|---|
| Install dir | `C:\Program Files\RaceIQ` (`{commonpf64}\RaceIQ`) |
| Elevation | `PrivilegesRequired=admin` (UAC prompt) |
| Data dir | `%APPDATA%\RaceIQ` (`{userappdata}\RaceIQ`) — survives reinstall |
| Start Menu | Yes — shortcut to `raceiq.exe` |
| Desktop shortcut | Optional (user-selectable during install) |
| Uninstaller | Registered in Add/Remove Programs |

### Bundled files

- `dist\raceiq.exe`
- `dist\public\` (Vite client assets)
- `dist\shared\` (track outlines, tunes, car data)

The `data\` directory (SQLite DB, `settings.json`) is **not** bundled — it is created at runtime in `%APPDATA%\RaceIQ` and left untouched by uninstall.

The Inno Setup script sets the `DATA_DIR` environment variable in the installed shortcut (or writes it to a launch wrapper) so the app writes to `%APPDATA%\RaceIQ` instead of the default `./data`. Without this, the app would attempt to write to `C:\Program Files\RaceIQ\data\` and fail silently.

### CI changes

The release workflow (`release.yml`) gains a step after the existing `Package` step on the Windows runner:

```yaml
- name: Build installer
  shell: cmd
  run: iscc /DMyAppVersion=%VERSION% installer\raceiq.iss

- name: Upload installer artifact
  uses: actions/upload-artifact@v4
  with:
    name: raceiq-v${{ needs.compute-version.outputs.version }}-setup
    path: RaceIQ-Setup-v${{ needs.compute-version.outputs.version }}.exe
```

The installer `.exe` is uploaded as a release asset alongside the existing ZIP.

---

## Updater

### Module

`server/updater.ts` — a self-contained module with no new dependencies. All operations use Bun's built-in `fetch`, `Bun.file`, and Node-compatible `fs`/`child_process`.

### API

```typescript
checkForUpdate(): Promise<UpdateInfo | null>
// Returns { version, downloadUrl } if a newer version exists, null otherwise.

applyUpdate(info: UpdateInfo): Promise<void>
// Downloads, stages, swaps files, relaunches.
```

### Version source

The running version is read from `package.json` at startup and stored in a module-level constant. The CI build does not need to embed it separately — `package.json` is already updated by the `finalize` workflow job before the binary is compiled.

### Check flow

1. `GET https://api.github.com/repos/Snazzie/RaceIQ/releases/latest`
2. Parse `tag_name` (e.g. `v1.2.3`) → strip `v` → compare with running version using semver comparison
3. If newer: find the asset whose name matches `raceiq-v*-windows-x64.zip`, return its `browser_download_url`

### Notification flow

1. `server/index.ts` calls `checkForUpdate()` after a 10-second startup delay, then every 4 hours via `setInterval`
2. On update found: broadcast a `{ type: "update-available", version }` WebSocket message to all connected clients + signal the tray to show a balloon notification
3. Tray shows: *"RaceIQ vX.X.X is available. Click to install."*
4. Tray gains an **"Install Update"** menu item (hidden when no update is available)
5. Clicking the tray notification or menu item sends a message back to the server to begin `applyUpdate()`
6. A browser UI prompt (toast or modal): **"Update to vX.X.X?"** with **Install** / **Later** buttons
   - **Later**: dismisses, update info is retained for the session
   - **Install**: calls `POST /api/update/apply`

### Apply flow

1. Download release ZIP to `%TEMP%\raceiq-update-vX.X.X.zip`
2. Extract to `%TEMP%\raceiq-update-vX.X.X\`
3. Write a small PowerShell swap script to `%TEMP%\raceiq-apply-update.ps1` that:
   - Waits for the main process to exit (polls by PID)
   - Renames `raceiq.exe` → `raceiq.exe.old`
   - Copies extracted files over `C:\Program Files\RaceIQ\`
   - Launches the new `raceiq.exe` as a detached process
4. Spawn the swap script elevated via `Start-Process powershell -Verb RunAs` (triggers a UAC prompt)
5. Current process exits

On next startup: delete `raceiq.exe.old` if present.

> **Why elevated spawn?** The running app process is not elevated after a normal launch, so it cannot write directly to `C:\Program Files\`. A UAC-elevated PowerShell script handles the privileged file operations — same pattern as the existing tray implementation.

On next startup: delete `raceiq.exe.old` if present.

### API routes

`GET /api/update/check` — runs `checkForUpdate()` on demand. Returns `{ available: false }` or `{ available: true, version, downloadUrl }`. Used by the Settings UI "Check for Updates" button.

`POST /api/update/apply` — triggers `applyUpdate()`. No body needed. Returns `204` before the process exits. Requires the update info to have been previously fetched (stored in module state).

### Manual check from UI

The Settings modal gains a **"Check for Updates"** button. Clicking it calls `GET /api/update/check`:
- If up to date: shows inline text "You're on the latest version (vX.X.X)"
- If update available: shows the same Install/Later prompt used for automatic notifications

### Scheduling

```typescript
// server/index.ts
checkForUpdate().then(notifyIfAvailable);
setInterval(() => checkForUpdate().then(notifyIfAvailable), 4 * 60 * 60 * 1000);
```

---

## Tray changes

`server/tray.ts` currently communicates via process exit codes. For update notifications it needs bidirectional signalling:

- **Server → tray**: write a command to a temp file that the PowerShell script polls (simple file-based IPC, no new dependencies)
- **Tray → server**: the "Install Update" menu item calls `POST /api/update/apply` via `Invoke-WebRequest`

The tray script polls the command file every 5 seconds. Commands: `show-update-notification:vX.X.X`, `show-update-menu-item`.

---

## File layout after install

```
C:\Program Files\RaceIQ\
  raceiq.exe
  public\          ← Vite assets
  shared\          ← track outlines, tunes

%APPDATA%\RaceIQ\
  forza-telemetry.db
  settings.json
```

---

## Out of scope

- macOS/Linux installers
- Rollback / downgrade
- Delta updates (always full ZIP swap)
- Code signing (can be added later)
