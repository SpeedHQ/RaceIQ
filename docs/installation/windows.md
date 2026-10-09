# Windows installation

Windows is recommended for full RaceIQ support, including live shared-memory telemetry from ACC, Assetto Corsa Evo, and iRacing.

## Install and run

1. Download latest `RaceIQ-Setup` installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest).
2. Run installer and follow setup wizard. Select **Create a desktop icon** to add an optional desktop shortcut.
3. Double-click the desktop shortcut or start RaceIQ from the Start menu. The shortcut starts the server if it is not already running, waits for the dashboard to respond, then opens it in your default browser.

Open <http://raceiq.localhost> in a modern browser while RaceIQ is running. Installed Windows builds use port 80, so no port suffix is needed (`http://raceiq.localhost:80` is equivalent). No DNS registration or administrator access is needed: browsers resolve `.localhost` names to this computer. If your browser does not support `.localhost` names, use <http://localhost> instead.

You can also reopen the dashboard anytime by clicking the RaceIQ tray icon.

Port 80 must be available. If another application already uses it, RaceIQ will not stop that application; free the port before starting RaceIQ. Development builds continue to use port 3117.

## Telemetry

For Forza Motorsport and F1, configure game telemetry to send UDP data to `127.0.0.1:5301`.

ACC, Assetto Corsa Evo, and iRacing use native Windows shared-memory telemetry. Run RaceIQ on same Windows machine as game for live capture.

## Updates

RaceIQ checks for releases automatically. Force check from **Settings → About → Check for updates**. When update is available, install it from RaceIQ update prompt.

## Data storage

Application data is stored at `%APPDATA%/raceiq`, including database, settings, recordings, and imported state.
