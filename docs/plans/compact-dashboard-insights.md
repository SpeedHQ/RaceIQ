# Compact dashboard insights

## Requirements

Replace Practice rhythm with Podiums, remove Pace progress, and rename Clean driving to Clean laps. Keep compact overview placement below global game cards and existing game-specific placement. Preserve clean-lap calculation, localization, accessibility, and unrelated dashboard sections.

Podiums show confirmed completed own-race podium total and first/second/third breakdown across all loaded sessions, respecting selected game. Never count laps, practice, qualifying, others' sessions, provisional results, or duplicate session IDs. Unknown race outcomes must not display as zero podiums. Loading/error must not masquerade as zero. Use recorded result positions; no invented class positions or unsupported counts.

Extend Podiums with a sorted distribution of recorded finishing positions from fourth place onward, using exactly the same eligible races as the podium counts. Show first-, second-, and third-place counts prominently.

Keep first-, second-, and third-place trophy slots visible in every result state. Show recorded counts, including zero, when confirmed results exist; use an em dash during loading, errors, or unavailable results rather than fabricating zero.

Show the total eligible confirmed finished races beside the Podiums title, including non-podium results. Move explanatory and unavailable-result copy into accessible info-icon tooltips beside widget titles; support hover and keyboard focus while retaining visible loading/error feedback.

Replace the Practice vs race time widget with three compact cyan/dark charts matching supplied references: (1) Track distribution, summing positive finite completed owned-lap seconds (valid and invalid) by gameId plus track identity, showing top tracks and Others, total hours, and shares; (2) Consistency, using the latest 10 deduplicated owned sessions in the current selected game/period, ordered by `createdAt` then id. For each session, calculate population standard deviation from at least two valid, finite, positive laps sharing its game/track/car context. Display the mean of available session deviations as headline and histogram session-deviation counts in five bins (<0.2, 0.2–0.4, 0.4–0.6, 0.6–0.8, >=0.8 seconds). Do not backfill older sessions when recent sessions lack comparable laps or combine raw times across tracks/cars. (3) Track stats, showing recorded lap-time bars by Practice (including test-day), Qualifying, and Race for the selected track, excluding unknown session types and labeling the denominator.

Track stats automatically uses newest valid track/car context, falling back to newest recorded context when no valid lap exists; show chronological valid-lap trend and session-type time bars only for that same game/track/car. Provide no context picker. All charts use owned recorded completed laps, not idle/incomplete time or elapsed session duration.

Resolve displayed track names through one client-safe per-game helper. Reuse game registry adapters for numeric track identities (`getTrackName(number)` / `getSharedTrackName(number)`) and exact LMU catalog string identities via `getLMUTrack` / `resolveLMUTrack`; keep display/common names separate from track identity and preserve layout identity. Do not import filesystem/server `resolve-name` modules, infer prefix aliases, or default unknown IDs to a game/track. Keep unknown tracks as honest localized fallbacks. LMU catalog ID `bahrainwec_2023/bahrainwec` displays `Bahrain International Circuit`, while observed session identity `bahrainwec_2023/bahrainwec_paddock` displays exact catalog name `Bahrain Paddock Circuit` (not the base venue). Observed `Circuit de Spa-Francorchamps` identity must retain that canonical display; catalog name may match multiple layouts, so do not assume a specific layout. `commonTrackName=sakhir` is a geometry slug, not UI label. The user's `bahrainwec_2023/ba` text is truncated; do not treat it as an identity or prefix alias.

Preserve existing selected-period/game scope: `HomePageContainer` already supplies period-filtered `dashboardLaps` and `dashboardSessions` to overview insights. Do not expand to all-history data, add another filtering path, or otherwise widen upstream results. Preserve empty/loading/error states, accessibility, all 12 locales, responsive narrow-width behavior, and unrelated dashboard widgets.

### Dashboard packing refinement

Group Clean laps and Consistency vertically inside one shared surface. Use four equal-height insight groups on wide workspaces, two columns on medium workspaces, and one column on narrow workspaces. Reserve 21rem per desktop group, with internal scrolling for unusually long podium distributions; narrow layouts retain natural height. Keep all existing data, states, and tooltips accessible.

Expand the consistency histogram to ten bins: 0.1-second intervals from zero to 0.9 seconds, followed by an inclusive >=0.9-second overflow bin. Show compact lower-bound axis labels with full interval descriptions available to assistive technology and on hover. Preserve the latest-ten-session sample and mean calculation.

Verify the running dashboard at desktop and mobile widths, histogram boundary/count behavior, and repository typecheck.

## Implementation

Replace former practice/race aggregation with per-track owned-lap duration aggregates and selected-context session-type/time-series data. Keep game/track/car identity explicit. Resolve labels through a reusable client-safe per-game helper using existing registry adapters for numeric identities and exact LMU catalog IDs for string identities; migrate duplicated RecentSessions LMU lookup if appropriate. Never import server/filesystem `resolve-name` paths or invent prefix aliases/default games; localized unknown labels remain honest. Derive consistency from ten newest deduplicated owned sessions in selected game/period, ordering `createdAt` then id; compute per-session population standard deviation from >=2 valid positive finite laps on same game/track/car. Headline is mean of available per-session deviations; histogram counts session deviations in five absolute bins. Never backfill older sessions or compare raw laps across tracks/cars. Track stats defaults to newest valid track/car, or newest recorded context if no valid lap exists; no picker.

## Verification

Run focused behavioral regressions for owned-lap identity, valid/invalid inclusion rules, ten-session cutoff/order and deduplication, per-session variability sample threshold, histogram session bins/mean headline, context default/fallback, chronological trend, session-type classification/denominator, top-tracks-plus-Others totals, and canonical labels. Verify numeric identities through game adapters; exact LMU ID `bahrainwec_2023/bahrainwec` maps to `Bahrain International Circuit`, `bahrainwec_2023/bahrainwec_paddock` maps to `Bahrain Paddock Circuit` without variant collapse, and observed `Circuit de Spa-Francorchamps` identity retains that display without forcing an ambiguous layout. Truncated/unknown IDs remain localized fallbacks, with no server/filesystem `resolve-name` import or default-game behavior. Run locale parity, full `bun run typecheck`, and changed-file lint. Exercise actual chart components in authorized page-only Playwright at desktop and mobile widths, including period/game changes, no-picker behavior, selected-context and viewport-intersection states, and populated/empty/loading/error states. Save browser/gate evidence under `.omp/evidence/track-analytics-charts/`. No desktop/native control.

## Decision record

[Compact dashboard insight row](../adr/0003-compact-dashboard-insights.md)

