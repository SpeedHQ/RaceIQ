# Windows installation

Windows is recommended for full RaceIQ support, including live shared-memory telemetry from ACC, Assetto Corsa Evo, and iRacing.

## Install and run

1. Download latest `RaceIQ-Setup` installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest).
2. Run installer and follow setup wizard.
3. Start RaceIQ from installed shortcut or Start menu.

Open dashboard by clicking RaceIQ tray icon, or visit <http://localhost:3117> in browser. Reopen it anytime through tray icon.

New installations listen only on localhost and ask you to choose password protection during setup. Protected dashboards use password-only sign-in; no username is required. Select LAN or Tailscale interfaces in **Settings → Access & security**, save, and restart before using another device. Existing all-interface listeners are preserved during upgrades until you change them.

Browser-origin whitelisting is off by default. Enable it in Access & security, or supply a nonempty `SERVER_ALLOWED_ORIGINS` environment setting. If enabled, include the exact external origin for MagicDNS, tunnel, or HUD hostname links. See [dashboard access and security](network-access.md) for configuration.

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

## Optional live-engineer voice pack

Live Engineer voice audio downloads separately from RaceIQ and remains optional. When enabled for the release, setup offers installation after Sound setup; choose **Skip for now** to finish without downloading or changing Radio preferences. Use **Settings → Live Engineer** to install or manage the package later.

Live Engineer settings show installed, minimum supported, and latest compatible package revisions, plus installed/required engine, catalog, and locale. Use **Check for updates** for a manual check even when Radio audio is off. Automatic checks run 10 seconds after startup, every four hours, and when audio changes from both-off to enabled. Automatic checks and the bottom-right update prompt require both the release feature and at least one enabled Radio audio switch. Installation never enables those switches. Failed downloads, integrity checks, or publication leave the existing package intact and allow retry.

Voice-pack manifests declare `catalogVersion` (segment/recipe compatibility), `engineVersion` (runtime compatibility), `packageVersion` (recording revision), and `language` (locale). Catalog and engine requirements must match; package revision may be newer than the minimum when otherwise compatible. Voice assets live in `%APPDATA%\\RaceIQ\\userdata\\voice-packs`, outside the application install directory.


## Data storage

Application data is stored at `%APPDATA%/raceiq`, including database, settings, recordings, and imported state.
