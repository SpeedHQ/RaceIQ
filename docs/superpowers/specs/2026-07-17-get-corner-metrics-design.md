# get_corner_metrics — Agent Tool Design

Date: 2026-07-17
Status: Approved (design), pending implementation

## Problem

None of the AI agents can pull per-corner telemetry on demand. Corner data is
computed once at prompt-build time (`buildCornerData`) and inlined as text. When a
user asks a follow-up like "what about turn 3?", the chat agents cannot fetch the
numbers. Compare Engineer has zero tools at all. The metric math already exists but
is trapped inside a string formatter.

## Goal

Expose per-corner telemetry as a structured, machine-readable tool available to all
five agents (Lap Analyst, Lap Chat, Compare Engineer, Compare Chat, Setup Engineer).

## Architecture

- New file `mastra/tools/corner-metrics.ts` exporting `getCornerMetricsTool`
  (`createTool`), following the pattern of `mastra/tools/f1-setup-compare.ts`.
- Refactor `server/ai/corner-data.ts`:
  - Extract the inline metric computation from `buildCornerData` into a pure,
    exported function `computeCornerMetrics(packets, corners, speedUnit): CornerMetrics[]`.
  - `buildCornerData` calls `computeCornerMetrics` then formats the string. No
    behavior change to its output.
  - Export the `CornerMetrics` type.
- The tool calls `computeCornerMetrics` and maps to its zod output schema. Metric
  math lives in exactly one place.

## Data flow

`getCornerMetricsTool.execute({ lapId, cornerId? })`
1. `getLapById(lapId)` → `{ telemetry, trackOrdinal, gameId }` (returns `null` if
   missing; may carry `parseError`).
2. Guard: no lap → `available:false, reason:"lap not found"`. No trackOrdinal, no
   telemetry, or `parseError` → `available:false` with matching reason.
3. `getCorners(trackOrdinal, gameId)` → corner defs. Empty → `available:false,
   reason:"no corners for track"`.
4. Resolve `speedUnit` from settings (`unit === "metric"` → `"kmh"`, else `"mph"`).
5. `computeCornerMetrics(telemetry, corners, speedUnit)`.
6. If `cornerId` provided, filter to that corner (by index/ordinal). Out of range →
   `available:false, reason:"corner N not found"`.

## Input / output (zod)

```
input: {
  lapId: number,
  cornerId?: number   // omit = all corners; 1-based ordinal
}

output: {
  available: boolean,
  lapId: number,
  trackName?: string,
  speedUnit: "mph" | "kmh",
  reason?: string,     // present only when available === false
  corners: Array<{
    label: string,
    entrySpeed: number,
    minSpeed: number,
    exitSpeed: number,
    gear: number,
    brakingDistance: number,
    timeInCorner: number,
    avgThrottle: number,
    avgBrake: number,
    throttleOnDist: number,
    balance: "oversteer" | "understeer" | "neutral"
  }>
}
```

Fields mirror the existing `CornerMetrics` interface exactly. `emptyResult(lapId,
reason)` helper returns `available:false, corners:[]`, mirroring
`f1-setup-compare.ts`.

## Wiring

Add `getCornerMetricsTool` to the `tools` object of all five agents:
- `mastra/agents/lap-analyst.ts`
- `mastra/agents/lap-chat.ts`
- `mastra/agents/compare-engineer.ts` (first tool it gains)
- `mastra/agents/compare-chat.ts`
- `mastra/agents/setup-engineer.ts`

Compare agents call the tool once per lapId. Agent instructions get a one-line note
that the tool exists and takes a `lapId`.

## Testing (TDD)

`test/corner-metrics.test.ts`:
1. `computeCornerMetrics` — fixture packets + corner defs → asserts entry/min/exit
   speed, gear, balance for a known corner.
2. `computeCornerMetrics` — empty packets or empty corners → `[]`.
3. Tool `execute` — missing lap → `available:false, reason:"lap not found"`.
4. Tool `execute` — lap with corners → structured `corners[]` populated,
   `cornerId` filter returns single corner.

`test/corner-data` regression: `buildCornerData` string output unchanged after
refactor (assert against a known fixture, or reuse existing coverage if present).

## Non-goals (YAGNI)

- No new corner-detection logic; consume existing `getCorners`.
- No caching beyond what `getLapById` already does.
- No cross-lap diffing inside the tool — the agent composes two calls.
