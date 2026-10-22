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

Voice audio is distributed separately from RaceIQ. Open **Live → Radio** before starting a simulator. Radio shows **Download required** when no pack is installed and **Update required** when the installed pack has an unsupported engine version, package revision, language, or incomplete files. Use its download link for the exact supported pack, not the latest app release. Voice switches remain unavailable until a compatible pack exists; saved preferences and text callouts are preserved.

If replacing an existing pack manually, extract the new ZIP to a temporary folder first and verify it contains the complete `live-engineer\qwen-v3` directory before moving it into place. Keep a copy of the previous `qwen-v3` directory until the replacement is confirmed.

Voice-pack manifests declare `catalogVersion` (segment/recipe compatibility), `engineVersion` (runtime compatibility), `packageVersion` (recording revision), and `language` (locale). Current dependency is catalog `1.0.0`, engine `1`, English (`en`) pack `1.0.0`. Download `live-engineer-qwen-v3-en-1.0.0.zip` from separate `voice-pack-en-v1.0.0` release. Close RaceIQ, extract into `%APPDATA%\RaceIQ\userdata\voice-packs`, and confirm `live-engineer\qwen-v3\manifest.json` exists. Restart RaceIQ and use **Check again** in Radio. Do not extract into app install directory.


## Data storage

Application data is stored at `%APPDATA%/raceiq`, including database, settings, recordings, and imported state.
