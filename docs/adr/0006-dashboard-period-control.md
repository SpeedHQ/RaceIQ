# Dashboard-wide period filtering

Status: proposed

This proposed decision now applies shared period scope to every dashboard widget, replacing the independent calendar/latest/recent scope.

## Context

The period selector currently sits inside summary statistics while other dashboard data remains all-time, making the apparent period scope inconsistent.

## Decision

Place one period selector at the top-left of both dashboard variants. Apply its existing date boundaries to dashboard laps and sessions centrally, deriving game-card totals from the same lap set. Derive latest/recent sessions from the selected period and game; fetch the corresponding latest recap. Render activity over the same selected period with horizontal scrolling for long date ranges.

Reuse Sessions' `ToggleGroup03` for the period filter because both select a data scope rather than a content panel. Align default shared Tabs styling with its bordered segmented treatment while retaining tab semantics and explicit alternative variants.

## Rationale

One selected range gives every widget a consistent scope without adding backend queries. Empty periods must not retain historical calendar activity or unrelated latest/recent sessions. Keep the existing year default and local-today/rolling-week/month/year date boundaries.

## Plan

[Requirements and verification](../plans/dashboard-period-control.md)
