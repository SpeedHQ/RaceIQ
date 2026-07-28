# Telemetry fidelity: what sample rate actually buys us

**TL;DR** — We are **not** more accurate than a real MoTeC log, and we should
stop implying it. Our recordings emit at **63.5 Hz**, not the 100 Hz we intend.
Physics is genuinely fresh at that rate; the *graphics* page — lap time,
position, flags — only advances at ~40 Hz in the sim, so **37.8% of our frames
re-read an unchanged graphics page**. A real MoTeC `.ld` from AC logs suspension
travel and wheel speed at **200 Hz** — 3× our physics rate — and inputs at
60 Hz. We are ahead of it only on G-forces and status channels, which MoTeC logs
at 20 Hz.

What the data *does* support: sample rate matters for **transient channels and
event counting**, not for traces (section 3 vs 4), and our current format is
carrying an easy **~29% of raw bytes** in repeated graphics pages plus a
further curated per-channel-rate saving that we are not taking (section 6).

Measured against `test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`
(AC Evo, Porsche 992 GT3 R Rennsport at Brands Hatch, two complete laps) and
`2.16.967_Spa_AMGEVO_MoTeC` (Mercedes AMG GT3 Evo at Spa, 137.2 s stint,
55 channels). Locked in by `test/telemetry-fidelity.test.ts`.

## 1. We are not capturing at 100 Hz, and a third of each frame is a re-read

`server/games/acc/triplet-assembler.ts` polls shared memory on a `setInterval`
of `1000 / 100` (10 ms) and emits a triplet on **every poll — no dedupe, no
gating on page change**. So the intended rate is 100 Hz. What lands on disk is
not:

| Lap | Frames | Lap time | Emitted rate |
|-----|--------|----------|--------------|
| 2 | 6265 | 98.717 s | **63.5 Hz** |
| 3 | 6697 | 105.478 s | **63.5 Hz** |

Two independent laps agreeing to three significant figures rules out a one-off
stall. The cause is the **Windows default timer resolution of 15.625 ms**
(64.0 Hz). Any `setInterval` shorter than a tick is rounded up to it, because
libuv's loop hands its computed timeout to `GetQueuedCompletionStatus` and that
blocking wait is quantised to the system tick. Node and Bun do not raise the
resolution themselves, and since Windows 10 2004 a process no longer inherits a
raised resolution from some other app on the machine — it must call
[`timeBeginPeriod`](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)
for itself.

This is platform-specific, not a property of Bun. Probed on Linux, `setInterval`
is fine — `setInterval(10)` measures 10.07 ms mean (99.3 Hz), `setInterval(1)`
resolves to 1.06 ms. The bug only exists on the platform AC Evo capture actually
runs on.

Confirmed from the artifact itself, without needing a wall clock. The sim's own
`physicsPacketId` is the ruler: it advances **5.291 ticks per frame we store**,
bimodally 5 or 6, and the counter covers 106378 ticks over the session's 316.7 s
— so the sim's physics runs at **336 Hz** and our poll spacing was
5.291 × 2.98 ms = **15.8 ms**. A poll that genuinely ran at 10 ms would show a
mean delta of 3.35, bimodal 3/4. It does not. The interval really was a tick.

Two consequences the earlier draft missed:

- **The fix is not a drift-compensated scheduler.** Recomputing the next
  deadline from an absolute start only removes accumulated drift; it cannot make
  the OS wake you before the next tick. (Measured: drift compensation on Linux
  moves 10.07 ms to 10.00 ms — it corrects drift, not granularity.) The fix is
  to raise the process timer resolution via `bun:ffi` on `winmm.dll`, paired
  with `timeEndPeriod` on shutdown. We already `dlopen` `kernel32.dll` under a
  Windows guard in `server/games/acc/buffered-memory-reader.ts:159`, so there is
  precedent and no new dependency.
- **`triplet-assembler.ts` is not the only clamped timer.** The reader beneath
  it runs `setInterval(1000 / 300)` for physics and `setInterval(1000 / 60)` for
  graphics (`buffered-memory-reader.ts:243,279`). On Windows *all three* collapse
  to the same 64 Hz tick, so speeding up the assembler alone would just re-read
  buffers the reader had not refreshed. Raising the resolution unblocks the whole
  chain at once; fixing one timer in isolation achieves nothing.

### Status: fixed

`server/games/shared/win-timer-resolution.ts` raises the process timer
resolution via `timeBeginPeriod` on `winmm.dll`, clamped to the platform floor
reported by `timeGetDevCaps`. Both shared-memory readers
(`server/games/acc/shared-memory.ts`, `server/games/ac-evo/shared-memory.ts`)
acquire it immediately before arming any capture interval and release it in
`stop()`. It is **refcounted**, so ACC and AC Evo running back to back do not
fight over it, and **scoped to an active capture** rather than the process
lifetime, because a raised resolution costs power. Off Windows, and on Windows
if `winmm.dll` will not load, it is inert and capture continues at the coarse
tick.

Two things this does *not* prove, and which need a real Windows box to confirm:
the tables above still describe the pre-fix artifact (they are assertions about
a committed `.bin.gz`, not about live behaviour), and on Windows 11 an occluded
or minimised window-owning process may have its request ignored.
`currentPeriodMs()` reports what we asked for, not what was granted — read the
assembler's `pollIntervalMs` metrics (`ACC_METRICS=1`) for the truth.

It is *not* the pipeline's packet-rate filter — that is a floor guard that
discards sessions below 30 Hz (`server/lap-detector.ts:183`), not a decimator.

Worth stating plainly, because it reframes section 2: **the sim publishes physics
at 336 Hz** — above MoTeC's 200 Hz tier — and we discard 81% of it to a timer
default. The ceiling here is ours, not the sim's.

The second finding is about the *pages*, not the rate. AC Evo exposes two
shared-memory pages that advance independently, and we poll both on the same
tick:

| Page | Bytes/frame | Unchanged vs previous frame | Real update rate |
|------|-------------|-----------------------------|------------------|
| Physics | 800 | **<1%** | ~63.5 Hz (we keep up) |
| Graphics | 3944 | **37.8%** | ~40 Hz |
| Static | 256 | 100% (constant all session) | n/a |

So the honest statement is per-channel, not global. Physics-derived channels
(speed, suspension, wheels, G-forces) are fresh on essentially every frame we
write. Graphics-derived channels (lap time, track position, flags, pit state)
genuinely only change ~40 times a second because that is all the sim publishes.

⚠️ An earlier draft of this doc measured `CurrentRaceTime` repeats and reported
"our effective rate is 39.5 Hz". `CurrentRaceTime` comes off the *graphics*
page, so that number was a graphics-page statistic mislabelled as stale physics.
It has been corrected here and the assertion in
`test/telemetry-fidelity.test.ts` now checks each page separately.

**The actionable finding.** "Retain 100 Hz physics" is a statement about intent,
not about the data — the honest headline is 63.5 Hz physics. And because
graphics is 78.5% of every frame we store, re-reading it a third of the time
costs **~29% of all raw bytes written**, for zero information.

## 2. What MoTeC actually does — a curated per-channel split

The reference `.ld` does not log everything at one rate. It buckets channels by
what they are for:

| Declared rate | Channels | What |
|---------------|----------|------|
| **200 Hz** | 20 | `SUS_TRAVEL_*`, `WHEEL_SPEED_*`, `BUMPSTOPUP_RIDE_*`, `BUMPSTOPDN_RIDE_*`, `BUMPSTOP_FORCE_*` |
| **100 Hz** | 1 | `LAP_BEACON` |
| **60 Hz** | 6 | `STEERANGLE`, `SPEED`, `THROTTLE`, `BRAKE`, `CLUTCH`, `RPMS` |
| **50 Hz** | 10 | `EN_*` ECU/status channels, `TIME` |
| **20 Hz** | 18 | `G_LAT`, `G_LON`, `ROTY`, `GEAR`, `TC`, `ABS`, `BRAKE_TEMP_*`, `TYRE_PRESS_*`, `TYRE_TAIR_*` |

`n / declared_freq` lands on 137.2 s for every physics bucket, so the declared
rates are real, not aspirational. (The `EN_*` group is the exception — 5× more
samples than the stint length, so treat its declared 50 Hz as unreliable.)

Head to head, per channel, against our 63.5 Hz flat physics rate:

| Channel class | MoTeC | Us | Verdict |
|---------------|-------|-----|---------|
| Suspension travel, wheel speed, bumpstops | 200 Hz | 63.5 Hz | **MoTeC 3× ahead** |
| Steering, speed, throttle, brake, RPM | 60 Hz | 63.5 Hz | **Level** |
| G-forces, gear, TC/ABS, brake temps, tyre press/temps | 20 Hz | 63.5 Hz | **Us 3× ahead** |

So the defensible claim is *not* "we sample faster". It is: **we sample flat,
MoTeC samples deliberately.** We win where MoTeC decided the channel did not
deserve rate, and we lose badly on the four-corner damper channels that are the
whole reason MoTeC reaches for 200 Hz.

## 3. What decimation *does not* cost — traces are band-limited

Decimating our laps by 2.39× (to 26.6 Hz; nearest-sample, no interpolation — a
slower logger genuinely never saw the dropped values):

| Metric | Loss at 26.6 Hz |
|--------|-----------------|
| Apex speed (16 corners) | **+0.01 km/h** mean, +0.04 km/h worst |
| Peak lateral load, physical windows | 0.042 g mean, 0.078 g p90 |
| Corner detection — apexes found | **all of them**, within 3.8–5.0 m p90 |

Speed, load and racing line are band-limited: they do not contain information
above ~13 Hz, so a 26.6 Hz sampler reconstructs them fine. **A lap comparison, a
delta trace, a corner-by-corner speed breakdown, or an AI analysis built on
those channels would be indistinguishable at 26.6 Hz.** Anyone claiming our rate
makes those features more accurate is wrong, and this table is why.

The one wrinkle: corner *count* is not stable. Both laps detect 8 corners at
full rate and 9 after decimation — a spurious corner appears. Every real corner
survives (that is asserted), but the detector is not rate-invariant, which is
worth knowing before anyone feeds it mixed-rate imports.

## 4. What decimation *does* cost — discrete events

One sample at 26.6 Hz is 37.6 ms. Anything that starts and finishes inside that
window is not attenuated — it is **absent**.

| Event class | Events in stint | Shorter than one 26.6 Hz sample | Median duration |
|-------------|-----------------|--------------------------------|-----------------|
| Rear slip > 5% | 214 | **30 (14%)** | 142 ms |
| Front slip > 5% | 88 | **12 (14%)** | 126 ms |
| Mid-corner throttle lift | 118 | 11 (9%) | 173 ms |
| Trail braking | 24 | 1 (4%) | 236 ms |

Peaks show the same tail behaviour. Missed braking peak averages 1.4% of pedal
travel — but the **worst corner loses 22.4%**, because the peak lived in a
single sample. And the stint contains a 36.9 g lateral spike (an impact or kerb
strike, excluded from the load table above as non-physical for a GT3): a
one-sample event that a slower logger drops entirely.

**Read section 2 against this table.** The channels MoTeC puts at 200 Hz are
precisely the ones whose events are this short. Its 20 Hz tier — temps,
pressures, gear — is where nothing transient lives. That is not an accident, and
our flat rate is a worse answer than its curated one on both axes.

## 5. Why the mechanism is under-reading, not missing

An earlier draft of this doc claimed 26.6 Hz loses ~5% of wheel-slip events
outright. That was wrong by roughly 3×: the correct figure is 14%, and even that
overstates the *practical* loss, because the dominant failure is not a vanished
event but a **flattened** one. Durations are censored at our own sample period —
we cannot observe an event shorter than 15.7 ms, so the "shorter than one
26.6 Hz sample" column is itself a lower bound.

That censoring also means **this artifact cannot answer whether 200 Hz beats
63.5 Hz**. Both score 0% missed against a distribution that our own sampling
defined. Answering it needs a capture at a genuinely higher rate — or a
channel-by-channel comparison against the MoTeC file, which is now possible and
is the obvious next step.

## 6. The real win available: dedupe and a curated split

Sample rate is not where our format is weak. Redundancy is.

Each frame we store is 5024 bytes: 800 physics, 3944 graphics, 256 static.

| Change | Effect on raw bytes written |
|--------|-----------------------------|
| Drop repeated graphics pages (37.8% of frames re-read an unchanged page) | **−29%** |
| Hoist the static page out of the frame loop — it is constant for the whole session | **−5%** |
| Move the 41 of 107 channels that are temps, pressures, fuel, damage and session status to a 10 Hz tier (MoTeC puts them at 20 Hz) | not yet measured; a further large cut to what remains |
| First two combined | **~34% of raw bytes, for zero information loss** |

Caveat, stated plainly: this is a **raw-byte** saving, not a measured on-disk
saving. gzip already exploits repeated frames well, so the compressed win will
be smaller than 34% — we have not measured it. The unambiguous wins are parse
cost, in-memory footprint, and not lying to downstream consumers about how often
a tyre temperature genuinely changed.

**A warning about how to pick the split.** Sizing channels by a reconstruction
error metric is unsafe. Running RMS-error-vs-range over this stint recommends
`WheelRotationSpeedFL` at 2 Hz and `AccelerationZ` at 1 Hz — yet those channels
contain single-sample jumps of 10.6% and 53.2% of their full range respectively.
The metric is blind to exactly the transients section 4 says matter. **Tier
channels by what they are used for, cross-checked against MoTeC's own choices —
not by an error threshold.**

## 7. What this means for us

- **Justified by the data:** high rate matters for oversteer/understeer event
  detection, ABS and kerb strikes, countersteer, and any coaching feature that
  counts discrete events rather than reading a trace.
- **Not justified by the data:** that we are more accurate than MoTeC. On the
  channels that need rate we are 5× behind it. Nor that rate improves lap
  comparison, apex speeds, racing line, or AI analysis — those are identical at
  26.6 Hz.
- **Fix first:** the 63.5 ≠ 100 Hz Windows timer tick — raise process timer
  resolution once at capture start rather than touching individual intervals —
  and the re-storing of an unchanged graphics page. Both are bugs; neither needs
  this doc to justify it. Note the second is a *storage* bug, not an accuracy
  one — physics is fresh every frame. The first has headroom well past 100 Hz,
  since the sim publishes at 336 Hz.
- **Then consider:** a curated per-channel rate split, tiered by role.
- **Importing third-party logs** is safe for trace-based analysis and unsafe for
  event counting. An imported 20 Hz channel must not be compared against a
  native one on any event-count metric — and note that cuts both ways now: our
  63.5 Hz suspension trace must not be event-compared against MoTeC's 200 Hz.

## Reproducing

```bash
bun run test test/telemetry-fidelity.test.ts
```

The test asserts both halves — that smooth channels survive *and* that events do
not — so neither side of this can be quietly overstated later. It also pins the
per-page repeat fractions and the capture rate; if any of them move, the emit
path changed and sections 1 and 6 need rewriting rather than the thresholds
widening.
