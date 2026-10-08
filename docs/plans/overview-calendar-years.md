# Overview rolling activity calendar

ADR: [Rolling activity scope](../adr/0007-overview-calendar-years.md)

Current scope: [Dashboard-wide period control](dashboard-period-control.md) replaces the independent two-month range with the selected dashboard period. Daily cell styling and hover behavior remain applicable.

## Requirements
- Show a rolling two-calendar-month range, inclusive from the same local day two months ago through today; clamp the start day for shorter months. Advance daily, including while the dashboard remains open.
- Preserve game scope and independence from overview period filters.
- Match the compact reference with abbreviated month labels, Monday–Sunday rows, cyan square activity cells, and a Less–More legend.
- No gray card background, border, year navigation, summary statistics, or printed day numbers.
- Hover each cell to see its full localized date and recorded driving time, including empty days.

## Implementation
1. Aggregate unfiltered game-scoped laps within rolling local-date boundaries.
2. Build Monday-first week columns; omit outside-range and future dates.
3. Render an unframed compact heatmap using existing theme tokens and visible date tooltips.

## Acceptance
Verify complete rolling boundaries, leap February, short-month clamping, year rollover, Monday-first alignment, empty activity, range-only intensity, game scope, desktop/mobile rendering, and hover tooltip dismissal. Run client typecheck and rendered behavioral smoke scenarios.
