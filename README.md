

<p align="center">
  <img src="assets/raceiq-icon.png" alt="RaceIQ" width="200">
</p>

<h1 align="center">RaceIQ</h1>

<p align="center">
  Real-time racing telemetry dashboard, lap analysis and catalogue for <strong>Forza Motorsport 2023</strong>, <strong>F1 2025</strong>, <strong>Assetto Corsa Competizione</strong>, <strong>Assetto Corsa Evo</strong>, and <strong>iRacing</strong>.
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

Check out the [demo](https://www.youtube.com/watch?v=hWuIItofivA) and [screenshots](assets/screenshots/) to see it in action.

## Features

- **Live telemetry** — real-time dashboard with speed, inputs, tires, suspension, G-forces, and 3D car visualization
- **Track mapping** — includes track outlines with live car position and automatic track mapping for tracks that havent been included in the software
- **Lap analysis** — automatic lap and corner detection, side-by-side comparison with time deltas
- **AI coaching** — send any lap for AI-powered technique, setup, and tire feedback
- **Vehicle setup** — tune catalog, car browser with performance data
- **Tune analysis** — compare the fastest tunes/setups and see popular setting ranges across the community

## Supported Games

| Game | Status | Public Tunes | Public Guides | Tune Creator |
|------|--------|--------------|---------------|--------------|
| Assetto Corsa Evo | Supported | No | No | No |
| F1 2025 | Supported | Yes | Yes | No |
| Assetto Corsa Competizione | Supported | Yes | Yes | No |
| Forza Motorsport 2023 | Supported | No | No | Yes |
| iRacing | Supported (Windows native SDK) | No | No | No |
| Le Mans Ultimate | Planned | — | — | — |

### Development priority

Supported games are listed in priority order. Priority is based on ongoing game support and freshness — how actively each title is still being updated by its developer:

1. **Assetto Corsa Evo** — actively developed, frequent content updates.
2. **iRacing** — actively developed and read directly through its Windows shared-memory SDK.
3. **F1 2025** — current-season title, actively maintained telemetry spec.
4. **Assetto Corsa Competizione** — stable and widely raced, but feature-complete upstream.
5. **Forza Motorsport 2023** — lowest priority; no longer meaningfully updated and its telemetry format is frozen.

Lower priority means slower turnaround on new features for that title — it does not mean deprecated. All supported games keep working.

## Getting Started

### 1. Download and install

Grab the latest installer from the [releases page](https://github.com/SpeedHQ/RaceIQ/releases/latest) and run it. Run RaceIQ and follow the setup wizard. 
* You can reopen the dashboard at any time by double-clicking the RaceIQ icon in the system tray.

### 2. Run and Connect

For Forza and F1, configure the game's telemetry settings to send UDP data to `127.0.0.1:5301`. ACC, AC Evo, and iRacing are detected automatically from their native Windows shared-memory telemetry. Start driving and telemetry will appear automatically.

> **Already forwarding telemetry to a wheel base or other app?** Use [UDP Forwarder](https://github.com/SpeedHQ/udp-forwarder) to send telemetry to multiple destinations at once.

## Updates

RaceIQ checks for new releases automatically and notifies you when one is available. You can also force a check at any time from **Settings → About → Check for updates**.

## Platform

> **Slow 3D wireframe playback?** Enable hardware acceleration in your browser when supported. Without GPU acceleration, Analyse playback may run far below the configured 60 or 120 FPS.

**Game on Windows is recommended.** RaceIQ runs on the same PC as the game for two reasons:

- **UDP reliability** — loopback delivery is lossless and low-latency, avoiding the packet loss and timing jitter of network routing.
- **Shared memory** — ACC, AC Evo, and iRacing expose local telemetry through Windows shared memory, which requires running RaceIQ on the same machine.

**Game on Console works.** Just make sure both your windows machine and console is wired ethernet.

## Data Storage

All data stays on your machine in `%APPDATA%/raceiq`:

- **Database** — every lap, session, analysis, tune, and profile stored in SQLite
- **Settings** — UDP port, units, active profile, and thresholds

The database is created automatically on first run. No cloud account or external service required.

## AI Coaching Setup

AI analysis is optional. Add your API key in the RaceIQ settings panel — multiple providers are supported. Analysis is sent directly to the provider's API, no intermediary server.

Want to run AI entirely on your own PC? See the [Local AI](guides/local-ai.md) guide.

## Sponsorship

Looking to sponsor this project or interested in a commercial license? Contact **Snazzie** on [Discord](https://discord.gg/ZNXKyYPumT) or find my socials on [GitHub](https://github.com/Snazzie).

## Contributing

RaceIQ is a community project and every contribution helps — whether that's code, car/track data, tune setups, bug reports, or just telling a friend about it. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and how to add support for new games.
