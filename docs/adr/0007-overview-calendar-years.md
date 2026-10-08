# Overview rolling activity scope

Status: proposed

Scope revised by [Dashboard-wide period filtering](0006-dashboard-period-control.md): activity now uses the shared selected period rather than an independent two-month range.

## Context
The overview activity calendar previously showed a full year with year navigation. The updated request specifies a compact, unframed two-month rolling heatmap advancing by day, without printed day numbers and with date tooltips.

## Decision
Show the inclusive local-date range from the same day two calendar months ago through today, clamping the start day in shorter months. Advance at local midnight. Keep game-scoped unfiltered laps independent of overview period controls. Use Monday-first weekday rows, abbreviated month markers, square cyan intensity cells, and a visible full-date hover tooltip.

## Rationale
A daily rolling window preserves recent activity without future cells or calendar-month resets. Local dates retain daily aggregation semantics; UTC date-component arithmetic counts days without daylight-saving-time drift.

## Plan
[Requirements and verification](../plans/overview-calendar-years.md)
