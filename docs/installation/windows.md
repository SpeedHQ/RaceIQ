# Windows installation

Windows is recommended for full RaceIQ support, including live shared-memory telemetry from ACC, Assetto Corsa Evo, and iRacing.

## Install and run

1. Download latest `RaceIQ-Setup` installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest).
2. Run installer and follow setup wizard.
3. Start RaceIQ from installed shortcut or Start menu.

Open dashboard by clicking RaceIQ tray icon, or visit <http://localhost:3117> in browser. Reopen it anytime through tray icon.

New installations listen only on localhost and ask you to choose password protection during setup. Protected dashboards use password-only sign-in; no username is required. Select LAN or Tailscale interfaces in **Settings → Access & security**, save, and restart before using another device. Existing all-interface listeners are preserved during upgrades until you change them.

Browser-origin whitelisting is off by default. Enable it in Access & security, or supply a nonempty `SERVER_ALLOWED_ORIGINS` environment setting. If enabled, include the exact external origin for MagicDNS, tunnel, or HUD hostname links. See [dashboard access and security](network-access.md) for configuration.

## Open a RaceIQ Online lap

In a track's **Community Laps** tab, select **Open lap** beside a downloadable result. RaceIQ downloads and registers that exact cloud-processed lap, then opens its replay. Imported laps retain the original driver's name and are kept separate from your own laps and personal-best statistics. An unavailable capture timestamp is shown as **Recording time unavailable**, not the upload time.

The Windows installer registers the `raceiq://` protocol. A website's **Continue in RaceIQ** action can start the app or forward a selected lap to the running instance. The link contains only the selected recording URL; the app uses its own Online sign-in, never website credentials. If sign-in is required, the pending request resumes after you connect.

Downloads show **Downloading**, **Validating**, and **Registering lap**. Transient failures offer retry; an unavailable recording offers a leaderboard refresh. Reopening the same cloud lap reuses its local import. Optional setup attachments are retained as opaque files and are never applied automatically.


## Manage password protection from the terminal

From the directory containing `raceiq.exe`, recover a forgotten dashboard password:

```powershell
.\raceiq.exe auth reset
```

The command prompts for a new password and confirmation without echoing input. To remove password protection instead, without knowing the current password:

```powershell
.\raceiq.exe auth disable --confirm-exposure
```

**Warning:** After disabling protection, anyone who can reach the dashboard can read and edit its data and settings and use configured AI chat. The required `--confirm-exposure` flag acknowledges that exposure.

Both commands invalidate stored sessions and preserve recordings, settings, and network choices. Use the same data directory as the running server; if you use a custom location, set `$env:DATA_DIR` to that directory before running the command. Remove `SERVER_PASSWORD` from both the running server and command environment first, and restart after removing that override. See [password recovery](network-access.md#password-recovery) and [terminal auth removal](network-access.md#disable-password-protection-from-the-terminal) for details.

## Telemetry

For Forza Motorsport and F1, configure game telemetry to send UDP data to `127.0.0.1:5301`.

ACC, Assetto Corsa Evo, and iRacing use native Windows shared-memory telemetry. Run RaceIQ on same Windows machine as game for live capture.

## Updates

RaceIQ checks for releases automatically. Force check from **Settings → About → Check for updates**. When update is available, install it from RaceIQ update prompt.

## Data storage

Application data is stored at `%APPDATA%/raceiq`, including database, settings, recordings, and imported state.
