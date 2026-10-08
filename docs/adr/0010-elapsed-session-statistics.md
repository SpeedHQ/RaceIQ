# Collective elapsed session statistics

Status: proposed

## Context

The dashboard Track stats panel restricts session-type bars to the latest track and sums completed lap times. The requested Session stats measures collective full elapsed time across sessions, including pits, idle time and incomplete laps.

## Decision

Use recorded capture timeline spans exposed through the existing sessions API as nullable elapsed seconds. Aggregate owned sessions across all tracks/cars in the selected game and period. Keep unavailable timing explicit; never substitute lap sums or infer session ends from another session's start. Exclude offline gaps between distinct capture segments and parser-context frames. Preserve the existing chart layout while showing durations and shares.

Include measured elapsed time for unrecognized session types in the collective total as Other. Prefer recorded acquisition UTC; legacy simulator session clocks and reliable ACC MoTeC sample clocks are recovery sources. Shared captures lacking full per-session bounds and sources lacking reliable clocks remain unavailable rather than being counted twice or guessed from laps.

## Rationale

Capture timestamps measure recorded elapsed time without excluding non-lap activity. Unknown historical timing cannot be reconstructed faithfully from lap metadata. Explicit unavailable coverage avoids presenting partial totals as complete.

## Plan

[Requirements and verification](../plans/elapsed-session-statistics.md)
