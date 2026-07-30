

<div align="center">
  <img src="assets/raceiq-icon.png" alt="RaceIQ" width="200">
</div>

<h1 align="center">RaceIQ</h1>

<p align="center">
  Free, open-source sim racing telemetry and driver improvement software for <strong>Forza Motorsport 2023</strong>, <strong>F1 2025</strong>, <strong>Assetto Corsa Competizione</strong>, <strong>Assetto Corsa Evo</strong>, and <strong>iRacing</strong>.
</p>

<p align="center">
  RaceIQ helps you turn every session into measurable progress: drive, review, understand where time is lost, make a change, and see whether you got faster.
</p>

<div align="center">
  <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest"><img src="https://img.shields.io/github/downloads/SpeedHQ/RaceIQ/total?style=for-the-badge&color=blue&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/SpeedHQ/RaceIQ/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SpeedHQ/RaceIQ?style=for-the-badge&color=blue" alt="License"></a>
  <a href="https://deepwiki.com/SpeedHQ/RaceIQ"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</div>

<div align="center">
  <a href="assets/screenshots/"><img src="https://img.shields.io/badge/Screenshots-View-6B5B95?style=for-the-badge&logo=googlephotos&logoColor=white" alt="View RaceIQ screenshots"></a>
  <a href="https://discord.gg/ZNXKyYPumT"><img src="https://img.shields.io/badge/Discord-22%20members-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join RaceIQ on Discord — 22 members"></a>
</div>

> **Alpha software** — expect bugs, rough edges, and AI analysis that's still being fine-tuned for accuracy. Some features aren't obvious yet, so poke around and join the [Discord](https://discord.gg/ZNXKyYPumT) if you get stuck.

<p align="center">
  <video src="https://github.com/user-attachments/assets/9200c90d-b039-4616-9b27-9c8e7c53a8ca" autoplay loop muted playsinline width="70%"></video>
</p>

---
## A Free Alternative to Paid Sim Racing Telemetry Apps

RaceIQ is a free, open-source alternative to [Track Titan](https://tracktitan.io/), [Coach Dave Delta](https://coachdaveacademy.com/delta/), [MoTeC i2](https://www.motec.com.au/products/I2), [Sim Racing Telemetry](https://www.simracingtelemetry.com/), and [Racing View](https://www.racingview.app/). Looking for a **Track Titan alternative**, **Coach Dave Delta alternative**, or **MoTeC alternative**? RaceIQ combines multi-sim telemetry, lap comparison, AI coaching, setup analysis, driver progress, MoTeC import, and hotlap benchmarking in one local-first app.

RaceIQ is a **sim racing improvement app**, not just an analysis tool. It gives you a repeatable way to improve your pace across practice sessions, cars, tracks, and supported sims.

Most telemetry tools answer, “What happened on this lap?” RaceIQ helps you answer the next questions:

- **Where am I losing time?** Compare laps, sectors, corners, racing lines, speed, braking, throttle, and time delta.
- **Why am I losing it?** Inspect the telemetry behind each mistake and use optional AI coaching for technique, setup, and tire feedback.
- **What should I change?** Save tunes, compare setup experiments, and connect laps to the setups you actually drove.
- **Did the change work?** Keep every lap and session in a local history, then use driver profiles, trends, activity, and recaps to track improvement over time.

The result is a complete loop: **drive → capture → review → change → measure → repeat**.

RaceIQ is free, open source, multi-sim, and local-first. Your telemetry, laps, analyses, conversations, tunes, experiments, and driver history stay on your machine. No cloud account is required.

It captures telemetry from your racing games, provides a live dashboard, records every lap to a local database, and gives you lap analysis, comparison, session recaps, driver trends, AI coaching, and 3D visualizations. It also includes car, track, tune, and setup tools so you can understand both driving technique and vehicle changes.

Check out the [demo](https://www.youtube.com/watch?v=hWuIItofivA) and [screenshots](assets/screenshots/) to see it in action.

## Why RaceIQ

RaceIQ combines the parts of a serious sim racing training workflow that are usually split across several tools:

- **Progress tracking, not one-off telemetry** — every session contributes to your driver history, trends, activity, and improvement story.
- **Actionable lap analysis** — find the corners and sectors that matter instead of staring at raw charts.
- **Driving and setup in one workflow** — associate laps with tunes, inspect setup ranges, run experiments, and compare the result.
- **MoTeC import** — bring `.ld` logs into RaceIQ so external sessions can join your analysis and comparison history.
- **Benchmark against hotlaps** — compare your pace with community reference lap times and study linked YouTube hotlaps for braking, lines, and technique.
- **Optional AI coaching** — ask for technique, setup, and tire feedback without sending telemetry through an intermediary server.
- **One app across your sims** — use the same improvement workflow in Forza Motorsport, F1 2025, ACC, AC Evo, and iRacing.
- **Free and local-first** — no subscription, no mandatory account, and no required cloud service.


## Features

- **Live telemetry** — real-time dashboard with speed, inputs, tires, suspension, G-forces, and 3D car visualization
- **Lap and corner analysis** — automatic lap and corner detection, side-by-side comparison, sector timing, time deltas, and telemetry charts
- **Driver progress** — session recaps, driver profiles, rolling trends, activity history, and improvement metrics
- **AI coaching** — optional AI-powered technique, setup, and tire feedback with persistent analysis conversations
- **MoTeC log import** — import compatible MoTeC `.ld` logs and analyse them alongside recorded sessions
- **Hotlap benchmarks** — compare against community reference lap times and open linked YouTube hotlaps from supported setup and track pages
- **Setup experiments** — save tunes, associate them with laps, compare setup changes, and inspect tune performance
- **Track mapping** — included track outlines with live car position plus automatic mapping for tracks not yet included
- **Car and track catalogue** — browse supported cars, tracks, performance data, guides, and setup information

## Supported Games


| Game | Status | Public Tunes | Public Guides | Tune Creator |
|------|--------|--------------|---------------|--------------|
| Assetto Corsa Evo | Supported | No | No | No |
| F1 2025 | Supported | Yes | Yes | No |
| Assetto Corsa Competizione | Supported | Yes | Yes | No |
| Forza Motorsport 2023 | Supported | No | No | Yes |
| iRacing | Supported (Windows native SDK) | No | No | No |
| Le Mans Ultimate | Blocked — awaiting game key / sponsorship | — | — | — |

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
