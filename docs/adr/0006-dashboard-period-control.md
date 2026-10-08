# Dashboard-wide period filtering

Status: proposed

Calendar scope and available periods are revised by [Overview calendar year scope](0007-overview-calendar-years.md).

## Context

The period selector currently sits inside summary statistics while other dashboard data remains all-time, making the apparent period scope inconsistent.

## Decision

Place one period selector at the top-left of both dashboard variants. Apply its existing date boundaries to dashboard laps and sessions centrally, deriving game-card totals from the same lap set. Keep latest and recent session history outside period filtering.

Reuse Sessions' `ToggleGroup03` for the period filter because both select a data scope rather than a content panel. Align default shared Tabs styling with its bordered segmented treatment while retaining tab semantics and explicit alternative variants.

## Rationale

One selected range gives aggregate widgets a consistent scope without adding backend queries or changing session navigation. Retaining unfiltered session history preserves access to the newest driving activity even when an older or empty range is selected.

## Plan

[Requirements and verification](../plans/dashboard-period-control.md)
