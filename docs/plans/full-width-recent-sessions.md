# Full-width recent sessions

ADR: [Compact latest-session summary](../adr/0005-full-width-recent-sessions.md)

## Requirements

Recent Sessions must occupy the full Overview content width, without Latest Session reserving a sidebar. Reduce Latest Session presentation. Show session type (Practice, Race, etc.) in recent sessions on global and per-game Overview.

## Implementation

Stack activity/statistics, a compact full-width latest-session summary, and Recent Sessions. Disable the recap track map only on Overview using its existing presentation option; omit the pace sparkline in compact mode and tighten metric spacing with six columns on wide containers. Preserve standalone recap, metrics, and actions. Reuse Sessions' type formatter and Type column label; absent/unknown type displays an em dash.

## Acceptance

Inspect populated global and per-game Overview at desktop and phone widths. Verify table spans content width, Type values match session data, no page-level horizontal overflow, and recap actions remain available. Run changed-file lint and client typecheck.
