<p align="center">
  <img src="assets/raceiq-icon.png" alt="RaceIQ" width="200">
</p>

<h1 align="center">RaceIQ</h1>

<p align="center">
  Local racing telemetry, lap analysis, setup tools, and optional AI coaching for Forza Motorsport 2023, F1 25, Assetto Corsa Competizione, Assetto Corsa Evo, and iRacing.
</p>

<p align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest"><img src="https://img.shields.io/github/downloads/SpeedHQ/RaceIQ/total?style=for-the-badge&color=blue&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/SpeedHQ/RaceIQ/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SpeedHQ/RaceIQ?style=for-the-badge&color=blue" alt="License"></a>
</p>

<p align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest">Download for Windows</a> · <a href="assets/screenshots/">Screenshots</a> · <a href="https://discord.gg/ZNXKyYPumT">Discord</a> · <a href="docs/README.md">Documentation</a>
</p>

> **Alpha software** — expect bugs, rough edges, and features that are still being refined.

RaceIQ captures live telemetry, records sessions and laps to a local SQLite database, provides live dashboards and lap comparison, and supports optional AI-assisted analysis. Data remains on your machine unless you configure an external AI provider.

## Features

- Live telemetry dashboards for speed, inputs, tires, suspension, G-forces, and car attitude.
- Automatic session, lap, sector, pit, corner, and track processing.
- Lap and corner comparison with telemetry charts and track views.
- Optional AI analysis and chat for technique, setup, and tire feedback.
- Car, setup, tune, and community-data browsing where supported.

## Supported games

| Game | Telemetry source |
|---|---|
| Forza Motorsport 2023 | UDP |
| F1 25 | UDP |
| Assetto Corsa Competizione | Windows shared memory |
| Assetto Corsa Evo | Windows shared memory |
| iRacing | Windows SDK/shared memory |

## Get started

1. Download and install the latest [Windows release](https://github.com/SpeedHQ/RaceIQ/releases/latest).
2. Run RaceIQ and complete setup.
3. For Forza and F1, configure game telemetry for `127.0.0.1:5301`.
4. For ACC, AC Evo, or iRacing, run RaceIQ on the same Windows machine as the simulator. RaceIQ detects the native telemetry source.
5. Start driving. Reopen the dashboard from the RaceIQ system-tray icon when needed.

If another application already receives UDP telemetry, use a splitter such as [UDP Forwarder](https://github.com/SpeedHQ/udp-forwarder).

## Data and AI

RaceIQ stores its database, settings, session recordings, and generated data under `%APPDATA%/raceiq`. No RaceIQ cloud account is required.

AI features are optional. External-provider requests go directly to the configured provider. To use an OpenAI-compatible model on your machine or LAN, follow [Local AI setup](docs/user-guides/local-ai.md).

## Documentation and contributing

- [Documentation](docs/README.md)
- [Local AI setup](docs/user-guides/local-ai.md)
- [Contributing](CONTRIBUTING.md)
- [Development setup](docs/contributing/development.md)
- [Architecture overview](docs/architecture/overview.md)

Bug reports, track and car data, setup data, code changes, and documentation improvements are welcome.

## Sponsorship

For project sponsorship or commercial licensing, contact **Snazzie** on [Discord](https://discord.gg/ZNXKyYPumT) or through [GitHub](https://github.com/Snazzie).
