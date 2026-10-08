# Dashboard-wide period control

ADR: [Dashboard-wide period filtering](../adr/0006-dashboard-period-control.md)

Subsequent scope revision: [Calendar year selection](overview-calendar-years.md) removes All time and makes calendar activity independent of the overview period.

## Requirements

Move the existing time period selector to the top-left of the overview and game dashboards. Today, week, month, year, and all-time must control all dashboard data, including game-card lap/time totals, Clean laps, Podiums, activity, and summary statistics. Latest Session and Recent Sessions remain independent of the selected period. Preserve game scope, localization, responsive wrapping, and the all-time default.

## Implementation

Use Sessions' `ToggleGroup03` component for period selection, separate from the summary panel. Make its bordered, outlined-active visual treatment the shared Tabs default; keep explicit pills and underline variants unchanged. Contain the five-option period selector in a horizontal scroller on narrow screens. Filter dashboard laps and sessions centrally using the existing local-today and rolling 7/30/365-day boundaries. Derive game-card totals from the same selected laps rather than independent all-time stats requests. Continue deriving latest/recent sessions from unfiltered session history.

## Acceptance and verification

Exercise period switching on populated overview and game dashboards; observe matching metric changes and unchanged latest/recent sessions, including an empty period. Inspect desktop and narrow layouts, keyboard selection, and selected-button state. Run frontend typecheck and focused insight tests. Record user-visible behavior in the changelog.
