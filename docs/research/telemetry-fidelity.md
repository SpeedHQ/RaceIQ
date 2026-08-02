# Telemetry Fidelity

This note records a fixture-backed experiment, not a simulator-wide sampling guarantee.

## Research question

Does RaceIQ's shared-memory capture cadence make smooth telemetry traces or short transient events materially more faithful than a lower-rate recording?

The experiment uses:

- `test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz` — AC Evo, Porsche 992 GT3 R Rennsport at Brands Hatch, including two complete laps;
- a private AC Evo MoTeC `.ld` reference — Mercedes-AMG GT3 Evo at Spa, 137.2 seconds, 55 channels. The source is not redistributed;
- `test/telemetry-fidelity.test.ts` — executable checks for capture cadence, duplicates, decimated traces, event duration, and peak attenuation.

Results describe these captures and current parsing behavior. They do not establish universal rates for AC Evo, ACC, MoTeC, Bun timers, or other machines.

## Findings

### Capture cadence and duplicate frames

`TripletAssembler` requests a snapshot every 10 ms, but the fixture contains approximately 63.5 emitted frames per second. About 37.8% repeat the preceding `CurrentRaceTime`, leaving approximately 39.5 distinct source updates per second.

This distinction matters:

- the assembler timer is an intended poll cadence;
- the file's frame rate is observed output cadence;
- distinct source updates are the effective information cadence for this marker.

The current assembler emits whenever all three pages exist; it does not require a physics-page change. Duplicate frames add processing and uncompressed storage without adding a new physics state. Gzip may compress repeated bytes well, so the corresponding on-disk saving has not been measured.

### MoTeC uses per-channel rates

The reference `.ld` does not expose one universal sample rate. Suspension travel and wheel speed are declared at 200 Hz, driver inputs and core vehicle values at 60 Hz, and temperatures/status channels at lower rates. RaceIQ's flat shared-memory record cadence is therefore neither categorically faster nor slower.

Comparisons must use channel-specific source resolution. An average channel rate is useful as a decimation experiment point, not as a description of the logger.

### Smooth traces tolerate decimation

The test decimates the RaceIQ fixture to 26.6 Hz using nearest samples and no interpolation. At that point:

- mean apex-speed error remains below 0.5 km/h and maximum below 1 km/h;
- typical peak cornering-load loss remains below 0.2 g at the 90th percentile;
- every full-rate corner is matched, with apex positions within 10 m at the 90th percentile.

These results support using moderate-rate data for trace-oriented tasks such as apex speed, racing-line comparison, and broad corner-load analysis on this fixture.

### Short events and peaks remain rate-sensitive

A lower-rate sampler can entirely miss an event shorter than one sample interval, depending on sampling phase. In this fixture, about 14% of rear-slip events are shorter than a 26.6 Hz interval, but that is not a 14% miss rate. Applying the random-phase model

$$P(\text{miss}) = \max(0, 1 - D/T)$$

gives an expected rear-slip miss rate around 5%, where $D$ is event duration and $T$ is the sampling period.

Under-reading caught events is the larger risk. Decimation keeps average peak loss modest, while the tail includes severe attenuation: the test requires at least one braking peak to lose more than 10% pedal travel and one rear-slip peak to lose more than 50% of its magnitude. Single-sample lateral-impact or kerb spikes also exist and may disappear entirely.

These findings apply to transient analysis such as slip-event counting, sharp brake peaks, impacts, and countersteer. A plausible but flattened event can be more misleading than an explicit gap.

## Interpretation

Supported conclusions:

- Poll cadence, emitted-frame cadence, and distinct-update cadence must be reported separately.
- Smooth trace analysis can remain stable after substantial decimation.
- Discrete-event counts and peak magnitudes are sensitive to channel-specific sampling rate and phase.
- Native recordings and imported logs must not be compared on transient-event counts without compatible channel rates.
- Removing unchanged source frames is a clear compute and memory improvement; compressed-disk savings require separate measurement.

Unsupported conclusions:

- RaceIQ is more accurate than MoTeC because it stores raw frames.
- One global sample rate describes either telemetry system.
- This fixture proves that 39.5, 63.5, 100, or 200 Hz is sufficient for every analysis channel.
- Decimation results from AC Evo automatically apply to other games or sources.

## Reproduction

```bash
bun run test test/telemetry-fidelity.test.ts
```

If capture-rate or duplicate assertions fail after a source-path change, update this note from new fixture measurements. Do not widen the thresholds to preserve historical claims.

## Related documentation

- [Telemetry recording](../architecture/telemetry-recording.md)
- [Telemetry reference](../reference/telemetry.md)
- [Generated telemetry catalog](../../shared/TELEMETRY_CATALOG.md)
