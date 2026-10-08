# Collective elapsed session statistics

ADR: [Elapsed session statistics](../adr/0010-elapsed-session-statistics.md)

## Requirements

Replace dashboard Track stats with Session stats. Aggregate all owned sessions across tracks and cars within the existing selected game and period. Show elapsed recorded session time, including pits, idle time and incomplete laps, split into Practice, Qualifying and Race with visible durations, shares and a collective total. Remove the latest-track/car subtitle. Do not label completed-lap sums as elapsed time.

## Implementation

Expose nullable `elapsedSeconds` through `SessionMeta` and the existing sessions API. Recover elapsed recorded spans from capture timestamps, keeping separate recording segments separate and excluding injected parser context. Reuse capture/source infrastructure; avoid repeating scans of unchanged recordings. Preserve existing sessions without recoverable timing as unavailable rather than guessing from lap times, file age or next session start. Handle compressed captures and recordings shared by session rows without double-counting.

Prefer recorder UTC timestamps and LMU's embedded acquisition UTC; use supported legacy simulator session clocks or ACC MoTeC sample time when recorder UTC is unavailable. Unclocked legacy captures, unsupported MoTeC clocks, and shared captures without reliable per-session recording bounds remain explicitly unavailable. Shared lap offsets cannot establish full-session spans, so do not assign whole-file duration to every session.

Replace track-context session aggregation with deduplicated owned-session aggregation. Preserve upstream game/period selection, current layout, localization and loading/error states. Include measured duration from unrecognized session types in the collective total and display its share as Other. Show unavailable duration coverage when applicable. Update translations, behavioral regressions and relevant stories.

## Acceptance

- Different tracks/cars collectively contribute session durations; no lap requirement.
- Pits, idle and incomplete-lap recorded time contribute; offline gaps between recording segments do not.
- Unknown timing remains unavailable and clearly disclosed, not silently zero or substituted lap totals.
- Ownership, selected game/period and deduplication remain correct.
- Capture-derived duration smoke, aggregation regression tests, actual desktop/mobile UI verification and repository typecheck pass.
