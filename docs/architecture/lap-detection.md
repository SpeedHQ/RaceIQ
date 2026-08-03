# Lap detection

Each game adapter constructs an `ILapDetector` for its telemetry timing
semantics. All implementations emit the same session/lap callbacks and persist
raw frame offsets for replay.

## Adapter map

| Game | Detector | Boundary source |
| --- | --- | --- |
| Forza Motorsport 2023 | `LapDetector` | `LapNumber` transition |
| F1 2025 | `LapDetector` | `LapNumber` transition and F1 session UID |
| Assetto Corsa Competizione | `LapDetectorAcc` | `CurrentLap` timer reset |
| Assetto Corsa Evo | `LapDetectorAcEvo` | `CurrentLap` timer reset |
| iRacing | `LapDetectorIRacing` wrapping `LapDetector` | physical lap change gated on native timing rollover |

Factories live in each `server/games/<game>/index.ts`. Detector IDs are stored
with sessions; changing an ID marks older recordings eligible for reprocessing.

## FM and F1: `LapDetector`

`server/lap-detection/detector.ts` uses the pure decisions in
`server/lap-detection/boundaries.ts`:

- `detectSessionBoundary()` handles car/track changes, F1 session UID changes,
  lap/distance resets, and silence.
- `detectLapBoundary()` handles normal increments, skipped lap numbers, and
  backward movement.
- `detectLapReset()` distinguishes a final-lap completion from a restart using
  `LastLap`.

A decreasing `TimestampMS` within one lap marks that lap as `rewind`. A
packet-rate filter suppresses low-rate menu/post-race trickle. The detector also
tracks fuel and tyre-wear history and can report debug state.

## ACC: `LapDetectorAcc`

`server/games/kunos/lap-detector.ts` cannot rely on `completedLaps` alone because ACC
publishes that counter after the physical start/finish crossing. It detects a
boundary when the prior `CurrentLap` is at least 30 seconds and the next value
is at most 2 seconds. A running peak provides lap time when `LastLap` has not
updated yet.

ACC-specific rules:

- discard short or pit-only fragments when recording starts mid-lap;
- abandon the in-progress buffer when distance moves backward by more than
  100 metres;
- classify out-laps, in-laps, and pit laps from `pitStatus`;
- guard against duplicate async emits;
- finalise a stale shared-memory session after 10 seconds without packets.

Detector ID: `acc_lapdetector_v2`.

## AC Evo: `LapDetectorAcEvo`

`server/games/ac-evo/lap-detector.ts` is a thin policy adapter over the shared
Kunos timer-reset, partial-lap, pit, duplicate-emit, and persistence lifecycle:

- unresolved car names receive stable discovered-car ordinals;
- car and track metadata can be backfilled after shared-memory static data
  appears;
- Kunos per-frame validity can mark track-limit cuts.

Detector ID: `ac_evo_lapdetector_v2`.

## iRacing: `LapDetectorIRacing`

iRacing changes its physical lap counter before publishing authoritative
`LastLap`. `server/games/iracing/lap-detector.ts` temporarily defers the first frames
of the next lap. It releases them to `LapDetector` only when `LastLap` changes
or the native SDK lap timer rolls over.

The first attached fragment is suppressed because RaceIQ may connect anywhere
around the circuit. If authoritative timing never arrives, deferred frames are
discarded rather than turning a sampled timer peak into a result. Unexpected
lap-number transitions must persist for two packets, filtering isolated zeroed
SDK frames without hiding a genuine restart or rewind.

Detector ID: `iracing_lapdetector_v3`.

## Shared contract

`server/lap-detection/types.ts` defines:

```ts
interface ILapDetector {
  readonly detectorId: string;
  readonly session: SessionState | null;
  feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void>;
  flushStaleLap?(): Promise<void>;
  flushIncompleteLap?(): Promise<void>;
  finalizeCurrentSession?(): Promise<void>;
  setCurrentLapByteOffset?(offset: number): void;
  getDebugState?(): Record<string, unknown>;
}
```

Optional fuel and tyre-wear histories are available on detectors that support
them.

All detectors use shared lap-quality assessment and sector computation before
persisting. End-of-stream import calls `flushIncompleteLap()` when implemented,
so a trailing partial lap is saved invalid rather than treated as complete.

## Tests

- `test/lap-detection.test.ts` covers pure FM/F1 boundary decisions.
- `test/lap-detector-ac.test.ts` covers ACC timing, partial starts, pit laps,
  session restarts, and duplicate protection.
- `test/iracing-sdk.test.ts` covers iRacing timing-gate behavior.
