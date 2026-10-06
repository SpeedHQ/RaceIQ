# Compact dashboard insights

## Requirements

Replace Practice rhythm with Podiums, remove Pace progress, and rename Clean driving to Clean laps. Keep compact overview placement below global game cards and existing game-specific placement. Preserve clean-lap calculation, localization, accessibility, and unrelated dashboard sections.

Podiums show confirmed completed own-race podium total and first/second/third breakdown across all loaded sessions, respecting selected game. Never count laps, practice, qualifying, others' sessions, provisional results, or duplicate session IDs. Unknown race outcomes must not display as zero podiums. Loading/error must not masquerade as zero. Use recorded result positions; no invented class positions or unsupported counts.

## Implementation

Expose stored result outcome status in SessionMeta through existing sessions query. Replace unused pace/practice computation with podium aggregation. Pass full sessions list from overview container to insights (not ten recent sessions). Keep two responsive columns from 640px, stacking below. Remove obsolete props, localization keys, stories, and tests for deleted widgets. Add behavioral podium regression coverage and populated/zero/unavailable/loading/error preview states.

## Verification

Run focused insight tests, localization key check, frontend typecheck and changed-file lint. Exercise rendered widget in browser at desktop and phone widths, including game filtering, zero versus unavailable, loading/error, and missing removed widgets. Smoke the server sessions query to confirm result status reaches consumers.

## Decision record

[Compact dashboard insight row](../adr/0003-compact-dashboard-insights.md)
