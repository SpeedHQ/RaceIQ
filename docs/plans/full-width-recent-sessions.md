# Full-width recent sessions

ADR: [Compact latest-session summary](../adr/0005-full-width-recent-sessions.md)

## Requirements

Recent Sessions must occupy the full Overview content width, without Latest Session reserving a sidebar. Reduce Latest Session presentation. Show session type (Practice, Race, etc.) in recent sessions on global and per-game Overview. Make the main dashboard more space efficient, move Latest Session directly beneath the game cards, and remove the dashboard lap-time trend graph.

## Implementation

On the global Overview, stack game cards, the compact full-width latest-session summary, insights, activity/statistics, and Recent Sessions. Use tighter section spacing, shorter desktop insight panels, and place activity beside summary statistics when space permits. Summary statistics adapt to their own available width. Remove the lap-time trend graph while preserving session-type bars, consistency, and track distribution. Keep per-game section order unchanged. Disable the recap track map only on Overview using its existing presentation option; omit the pace sparkline in compact mode and tighten metric spacing with six columns on wide containers. Preserve standalone recap, metrics, and actions. Reuse Sessions' type formatter and Type column label; absent/unknown type displays an em dash.

## Acceptance

Inspect populated global and per-game Overview at desktop and phone widths. Verify Latest Session immediately follows global game cards, the dashboard lap-time trend is absent, activity and statistics share a desktop row, table spans content width, Type values match session data, no page-level horizontal overflow, and recap actions remain available. Exercise period switching and recent-session navigation. Run repository typecheck and changed-file lint.
