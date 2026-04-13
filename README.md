<p align="center">
  <img src="assets/raceiq-icon.png" alt="RaceIQ" width="200">
</p>

<h1 align="center">RaceIQ</h1>

<p align="center">
  Real-time racing telemetry dashboard, lap analysis and catalogue for <strong>Forza Motorsport 2023</strong>, <strong>F1 2025</strong>, and <strong>Assetto Corsa Competizione</strong>.
</p>

<p align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest"><img src="https://img.shields.io/github/downloads/SpeedHQ/RaceIQ/total?style=for-the-badge&color=blue&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/SpeedHQ/RaceIQ/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SpeedHQ/RaceIQ?style=for-the-badge&color=blue" alt="License"></a>
</p>

<p align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest">Download for Windows</a> · <a href="https://www.youtube.com/watch?v=hWuIItofivA">Watch Demo</a> · <a href="assets/screenshots/">Screenshots</a> · <a href="https://discord.gg/ZNXKyYPumT">Discord</a>
</p>

---

> **Alpha software** — expect bugs, rough edges, and AI analysis that's still being fine-tuned for accuracy. Some features aren't obvious yet, so poke around and join the [Discord](https://discord.gg/ZNXKyYPumT) if you get stuck.

A free, open-source alternative to [Track Titan](https://tracktitan.io/), [Coach Dave Delta](https://coachdaveacademy.com/delta/), and [Racing View](https://www.racingview.app/).

RaceIQ is the most advanced sim racing telemetry app available to the public — and it's completely free. Whether you're chasing lap records, finding fast tunes, or just trying to understand why you're slow through turn 3, RaceIQ gives you tools that simply aren't available anywhere else.

It captures telemetry from your racing games, provides a live dashboard, records every lap to a local database, and gives you lap analysis and comparison (with optional AI coaching) and 3D visualizations — all running locally on your PC. It also includes a car and setup catalogue so you can browse and compare setups across tracks.

Check out the [demo](https://www.youtube.com/watch?v=hWuIItofivA) and [screenshots](assets/screenshots/) to see it in action.

## Features

- **Live telemetry** — real-time dashboard with speed, inputs, tires, suspension, G-forces, and 3D car visualization
- **Track mapping** — includes track outlines with live car position and automatic track mapping for tracks that havent been included in the software
- **Lap analysis** — automatic lap and corner detection, side-by-side comparison with time deltas
- **AI coaching** — send any lap for AI-powered technique, setup, and tire feedback
- **Vehicle setup** — tune catalog, car browser with performance data
- **Tune analysis** — compare the fastest tunes/setups and see popular setting ranges across the community
- **Driver profiles** — multiple profiles, lap export, and aggregate stats like laps completed and distance driven.

## Supported Games

| Game | Cars | Tunes |
|------|------|-------|
| Forza Motorsport 2023 | Yes | No |
| F1 2025 | Yes | Yes |
| Assetto Corsa Competizione | Yes | Yes |

## Getting Started

### 1. Download and install

Grab the latest installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest) and run it. Run RaceIQ and follow the setup wizard. 
* You can reopen the dashboard at any time by double-clicking the RaceIQ icon in the system tray.

### 2. Run and Connect

Configure your game's telemetry settings to send UDP data to `127.0.0.1:5301`, then start a race — telemetry will appear automatically.

> **Already forwarding telemetry to a wheel base or other app?** Use [UDP Forwarder](https://github.com/SpeedHQ/udp-forwarder) to send telemetry to multiple destinations at once.

## Platform

**Game on Windows is recommended.** RaceIQ runs on the same PC as the game for two reasons:

- **UDP reliability** — loopback delivery is lossless and low-latency, avoiding the packet loss and timing jitter of network routing.
- **Shared memory** — some games (like ACC) expose richer telemetry via shared memory, which requires running on the same machine.

**Game on Console works.** Just make sure both your windows machine and console is wired ethernet.

## Data Storage

All data stays on your machine in `%APPDATA%/raceiq`:

- **Database** — every lap, session, analysis, tune, and profile stored in SQLite
- **Settings** — UDP port, units, active profile, and thresholds

The database is created automatically on first run. No cloud account or external service required.

## AI Coaching Setup

AI analysis is optional. Add your API key in the RaceIQ settings panel — multiple providers are supported. Analysis is sent directly to the provider's API, no intermediary server.

## Sponsorship

Looking to sponsor this project or interested in a commercial license? Contact **Snazzie** on [Discord](https://discord.gg/ZNXKyYPumT) or find my socials on [GitHub](https://github.com/Snazzie).

## Contributing

RaceIQ is a community project and every contribution helps — whether that's code, car/track data, tune setups, bug reports, or just telling a friend about it. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and how to add support for new games.
