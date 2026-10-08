# Full-width recent sessions

ADR: [Compact latest-session summary](../adr/0005-full-width-recent-sessions.md)

## Requirements

Recent Sessions must occupy the full Overview content width, without Latest Session reserving a sidebar. Reduce Latest Session presentation. Show session type (Practice, Race, etc.) in recent sessions on global and per-game Overview. Make the main dashboard more space efficient, move Latest Session directly beneath the game cards, and remove the dashboard lap-time trend graph.

## Implementation

On the global Overview, stack game cards, the compact full-width latest-session summary, a compact totals strip, a responsive insights/activity group, and Recent Sessions. Size insights naturally to their content; stack Podiums above Track stats between Clean laps/Consistency and Track time distribution when the insight container is wide enough. Place activity beside insights only when the workspace has sufficient width. Summary statistics adapt to their own available width. Remove the lap-time trend graph while preserving session-type bars, consistency, and track distribution. Keep per-game section order unchanged. Disable the recap track map only on Overview using its existing presentation option; omit the pace sparkline in compact mode and tighten metric spacing with six columns on wide containers. Preserve standalone recap, metrics, and actions. Reuse Sessions' type formatter and Type column label; absent/unknown type remains an em dash.

## Acceptance

Inspect populated global and per-game Overview at desktop and phone widths. Verify Latest Session immediately follows global game cards, the dashboard lap-time trend is absent, totals form a compact strip, activity and insights share a desktop row, the table spans content width, Type values match session data, no page-level horizontal overflow, and recap actions remain available. Exercise period switching and recent-session navigation. Run repository typecheck and changed-file lint.

## Space-efficient arrangement refinement

Keep Latest Session full-width directly below the game cards. Put period totals in a compact full-width strip beneath the recap rather than centering small statistic cards beside a tall calendar. Group insights and activity in one top-aligned desktop row, with a bounded calendar column; stack them at smaller workspace widths. Within insights, use natural-height panels rather than fixed heights or internal scrolling. On sufficiently wide insight containers, stack Podiums and Track stats between Clean laps/Consistency and Track time distribution. Adapt against the insight container's own width. Preserve every metric, chart, period filter, state, tooltip, recap action, and full-width Recent Sessions table.

Verify populated desktop, intermediate, and phone layouts, period switching, absence of page overflow, fully visible histogram labels, and recap/table actions. Run repository typecheck and changelog validation.

## Widget height alignment

Use content-driven grid rows with stretched insight panels. Clean laps and Podiums share the first row height; Consistency and Track stats share the second. Track time distribution fills its two-row desktop span. Make component wrappers flex containers so their bordered child panels fill available row height. Retain natural single-column sizing, independent borders, all result states, and every chart label; do not add fixed heights or internal scrolling.

Verify paired top and bottom edges, the distribution's full-span edges, visible content, and absence of horizontal overflow on populated and empty desktop, intermediate, and mobile layouts. Run client typecheck and changed-file lint.
