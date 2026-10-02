# Windows installation

Windows is recommended for full RaceIQ support, including live shared-memory telemetry from ACC, Assetto Corsa Evo, and iRacing.

## Install and run

1. Download latest `RaceIQ-Setup` installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest).
2. Run installer and follow setup wizard.
3. Start RaceIQ from installed shortcut or Start menu.

Open dashboard by clicking RaceIQ tray icon, or visit <http://localhost:3117> in browser. Reopen it anytime through tray icon.

## Telemetry

For Forza Motorsport and F1, configure game telemetry to send UDP data to `127.0.0.1:5301`.

ACC, Assetto Corsa Evo, and iRacing use native Windows shared-memory telemetry. Run RaceIQ on same Windows machine as game for live capture.

## Updates

RaceIQ checks for releases automatically. Force check from **Settings → About → Check for updates**. When update is available, install it from RaceIQ update prompt.

## Data storage

Application data is stored at `%APPDATA%/raceiq`, including database, settings, recordings, and imported state.
