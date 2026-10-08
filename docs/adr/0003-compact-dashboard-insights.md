# Compact dashboard insight row

Status: proposed

## Problem

Activity frequency and pace progress no longer match requested overview content. Podium counts must represent recorded racing achievements, not transient race positions.

## Decision

Keep compact overview row below global game cards with Clean laps and Podiums. Replace Practice rhythm and remove Pace progress, including obsolete calculations and props. Podiums use full session history and existing canonical result authority: confirmed finished own races only, counted once per session with first/second/third breakdown. Expose stored outcome status through existing session metadata rather than creating another fetching/aggregation path. Preserve game filtering, theme, localization, accessibility, and game-specific placement.

Replace the former practice-versus-race widget with three compact cyan/dark charts: owned-lap time distribution by track (top tracks and Others), consistency by recent sessions, and selected-track session-type bars with chronological valid-lap trend. Track distribution sums positive finite completed owned laps (valid and invalid), grouped by gameId and track identity, with total hours and shares; it is not elapsed session or idle time. Consistency uses the latest ten deduplicated owned sessions in selected game/period ordered by createdAt then id; calculate each session's population standard deviation from >=2 valid positive finite laps on identical game/track/car context. Headline is mean of available per-session deviations; histogram counts deviations in five second bins. Never backfill older sessions or average raw lap times across tracks/cars. Track stats defaults to newest valid track/car, falling back to newest recorded context if none are valid. No context picker. Session bars classify practice (including test-day), qualifying, and race, exclude unknown types, and identify denominator.

Use one client-safe track display/common-name resolver: existing per-game registry adapters handle numeric identities; LMU catalog resolvers handle exact string identities. Reuse it for chart labels and existing RecentSessions LMU resolution where appropriate. Preserve layout identity and keep it distinct from display labels; never import filesystem/server `resolve-name` modules, invent prefix aliases, or default unknown IDs to a game. Unknown IDs retain localized unknown labels. Exact LMU catalog ID `bahrainwec_2023/bahrainwec` displays `Bahrain International Circuit`; observed `bahrainwec_2023/bahrainwec_paddock` displays its exact catalog name `Bahrain Paddock Circuit`, without collapsing to the base venue. The observed `Circuit de Spa-Francorchamps` identity retains that canonical display without assuming a specific layout. `commonTrackName=sakhir` is geometry metadata, not UI label. The user's `bahrainwec_2023/ba` text is truncated, not a resolvable prefix alias.

Preserve selected-period/game scope supplied by `HomePageContainer` through `dashboardLaps` and `dashboardSessions`; do not widen to all history or add parallel filtering. Preserve loading/error/empty states, accessibility, localization, responsive layouts, and unrelated dashboard content.

Pack Clean laps and Consistency into one shared vertical group and use four aligned 21rem-high groups on wide workspaces, two columns at intermediate widths, and natural-height single-column groups on narrow workspaces. Internal scrolling preserves long result distributions without enlarging desktop rows. Expand consistency to ten 0.1-second histogram bins, with the final bin covering >=0.9 seconds. Compact lower-bound labels avoid crowding; full interval descriptions preserve meaning.

## Consequences

Charts retain upstream period/game scope and avoid misleading cross-context comparisons. Recorded lap time is only duration source; excluding idle and incomplete-lap time avoids inferring elapsed duration. Recent-session consistency remains representative without silently reaching into older sessions; no raw times are compared across track/car boundaries. Track stats follows latest available context without requiring picker interaction. Canonical labels reuse existing game-specific resolvers; exact identity prevents ambiguous prefix matches, while localized unknown fallbacks remain honest.

## Plan

[Requirements and verification](../plans/compact-dashboard-insights.md)
