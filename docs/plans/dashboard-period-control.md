# Dashboard-wide period control

ADR: [Dashboard-wide period filtering](../adr/0006-dashboard-period-control.md)

Current scope revision: every dashboard widget follows the shared Today, This Week, This Month, and This Year tabs, including activity, Latest Session, and Recent Sessions.

## Requirements

The top-left period tabs control all overview and game-dashboard widgets: game-card totals, summary statistics, Clean laps, Podiums, consistency, track/session time distribution, activity, Latest Session, and Recent Sessions. Preserve existing local-today and rolling 7/30/365-day boundaries, game scope, localization, responsive behavior, and the year default. Activity displays the selected date range, not an independent two-month window.

## Implementation

Use the existing shared period selector and central filtered laps/sessions. Derive recent/latest sessions from the selected period and game before fetching the latest recap. Pass the selected period start to activity and remove its separate unfiltered lap prop. Activity retains readable daily cells through horizontal scrolling for longer periods. Keep loading/error states on both overview and game dashboards.

## Acceptance and verification

Exercise all four period tabs on populated overview and game dashboards; verify game totals, summary, clean trend, podiums, consistency, distributions, calendar range/activity, recent sessions, and latest recap change together, including empty periods. Inspect desktop/mobile charts and calendar scrolling. Run frontend typecheck and focused insight regressions. Record changed scope in the changelog.
