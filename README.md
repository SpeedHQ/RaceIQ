

<p align="center">
  <img src="assets/raceiq-icon.png" alt="RaceIQ" width="200">
</p>

<h1 align="center">RaceIQ</h1>

<p align="center">
  Real-time racing telemetry dashboard, lap analysis and catalogue for <strong>Forza Motorsport 2023</strong>, <strong>F1 2025</strong>, <strong>Assetto Corsa Competizione</strong>, <strong>Assetto Corsa Evo</strong>, <strong>iRacing</strong>, and <strong>Le Mans Ultimate</strong>.
</p>

<p align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest"><img src="https://img.shields.io/github/downloads/SpeedHQ/RaceIQ/total?style=for-the-badge&color=blue&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/SpeedHQ/RaceIQ/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SpeedHQ/RaceIQ?style=for-the-badge&color=blue" alt="License"></a>
  <a href="https://deepwiki.com/SpeedHQ/RaceIQ"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<p align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest">Download for Windows</a> · <a href="assets/screenshots/">Screenshots</a> · <a href="https://discord.gg/ZNXKyYPumT">Discord</a> · <a href="docs/README.md">Documentation</a>
</p>

> **Alpha software** — expect bugs, rough edges, and AI analysis that's still being fine-tuned for accuracy. Some features aren't obvious yet, so poke around and join the [Discord](https://discord.gg/ZNXKyYPumT) if you get stuck.

<p align="center">
  <video src="https://github.com/user-attachments/assets/9200c90d-b039-4616-9b27-9c8e7c53a8ca" autoplay loop muted playsinline width="70%"></video>
</p>

---

A free, open-source alternative to [Track Titan](https://tracktitan.io/), [Coach Dave Delta](https://coachdaveacademy.com/delta/), [Sim Racing Telemetry](https://www.simracingtelemetry.com/) and [Racing View](https://www.racingview.app/).

RaceIQ is the most advanced sim racing telemetry app available to the public — and it's completely free. Whether you're chasing lap records, finding fast tunes, or just trying to understand why you're slow through turn 3, RaceIQ gives you tools that simply aren't available anywhere else.

It captures telemetry from your racing games, provides a live dashboard, records every lap to a local database, and gives you lap analysis and comparison (with optional AI coaching) and 3D visualizations — all running locally on your PC. It also includes a car and setup catalogue so you can browse and compare setups across tracks.

Check out the [screenshots](assets/screenshots/) to see it in action.

## Features

- **Live telemetry dashboards** — real-time speed, inputs, tires, suspension, G-forces, fuel, ERS/DRS, and 3D car visualization
- **Session recording and history** — automatically save laps and sessions locally, filter your laps, review recaps, sector times, and pace statistics
- **Lap analysis and replay** — spot where time is gained or lost with corner detection, track playback, telemetry traces, insights, and sector maps
- **Compare laps** — see two laps side by side with time differences, fastest sectors, aligned track positions, and optional AI analysis
- **AI coaching and chats** — get feedback on driving technique, setups, tires, and long-term improvement, with saved conversations and optional local AI
- **Driver profile and trends** — track driving style, consistency, time loss, and improvement across recent laps
- **Tuning experiments** — test setup changes, coaching drills, and driving improvements, then review the results
- **Vehicle and setup catalogue** — browse cars, tracks, performance data, tunes, setup details, and community setting ranges
- **Tune analysis** — compare fast tunes and find popular setup ranges across the community
- **Track mapping and guides** — see your live position, map new tracks automatically, and use turn numbers, sectors, and track guides
- **Race results** — review qualifying, podiums, fastest laps, pit stops, strategies, and position timelines
- **Data portability** — import MoTeC logs and saved session captures; export individual laps or complete sessions
- **Multi-game support** — use RaceIQ with Forza Motorsport 2023, F1 2025, Assetto Corsa Competizione, Assetto Corsa Evo, iRacing, and Le Mans Ultimate

## Supported Games

| Game | Priority | Public Tunes | Public Guides | Tune Creator |
|------|----------|--------------|---------------|--------------|
| Assetto Corsa Evo | High | No | No | No |
| iRacing | High | No | No | No |
| Le Mans Ultimate | High | No | No | No |
| F1 2025 | Medium | Yes | Yes | No |
| Assetto Corsa Competizione | Medium | Yes | Yes | No |
| Forza Motorsport 2023 | Low | No | No | Yes |
Lower priority means slower turnaround on new features for that title — it does not mean deprecated. All supported games keep working.

## Getting Started

### 1. Download and install

Grab the latest installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest) and run it. Run RaceIQ and follow the setup wizard. 
* You can reopen the dashboard at any time by double-clicking the RaceIQ icon in the system tray.

### 2. Run and Connect

For Forza and F1, configure the game's telemetry settings to send UDP data to `127.0.0.1:5301`. ACC, AC Evo, iRacing, and LMU are detected automatically from native Windows telemetry. For LMU, enable **Gameplay > Enable Plugins**. Start driving and telemetry will appear automatically. LMU `.duckdb` files from `UserData/Telemetry` can also be uploaded from Sessions.

> **Already forwarding telemetry to a wheel base or other app?** Use [UDP Forwarder](https://github.com/SpeedHQ/udp-forwarder) to send telemetry to multiple destinations at once.

## Updates

RaceIQ checks for new releases automatically and notifies you when one is available. You can also force a check at any time from **Settings → About → Check for updates**.

## Platform

> **Slow 3D wireframe playback?** Enable hardware acceleration in your browser when supported. Without GPU acceleration, Analyse playback may run far below the configured 60 or 120 FPS.

**Game on Windows is recommended.** RaceIQ runs on the same PC as the game for two reasons:

- **UDP reliability** — loopback delivery is lossless and low-latency, avoiding the packet loss and timing jitter of network routing.
- **Native telemetry** — ACC and AC Evo use Windows shared memory, iRacing uses its SDK mapping, and LMU uses the built-in `LMU_Data` shared-memory interface.

**Game on Console works.** Just make sure both your windows machine and console is wired ethernet.

## Data Storage

All data stays on your machine in `%APPDATA%/raceiq`:

- **Database** — every lap, session, analysis, tune, and profile stored in SQLite
- **Settings** — UDP port, units, active profile, and thresholds

The database is created automatically on first run. No cloud account or external service required.

## AI Coaching Setup

AI analysis is optional. Add your API key in the RaceIQ settings panel — multiple providers are supported. Analysis is sent directly to the provider's API, no intermediary server.

Want to run AI entirely on your own PC? See the [Local AI setup guide](https://github.com/SpeedHQ/RaceIQ/blob/main/docs/user-guides/local-ai.md).

## Sponsorship

Looking to sponsor this project or interested in a commercial license? Contact **Snazzie** on [Discord](https://discord.gg/ZNXKyYPumT) or find my socials on [GitHub](https://github.com/Snazzie).

## Contributing

RaceIQ is a community project and every contribution helps — whether that's code, car/track data, tune setups, bug reports, or just telling a friend about it. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and how to add support for new games.
