# Compact dashboard insights

## Requirements

Replace Practice rhythm with Podiums, remove Pace progress, and rename Clean driving to Clean laps. Keep compact overview placement below global game cards and existing game-specific placement. Preserve clean-lap calculation, localization, accessibility, and unrelated dashboard sections.

Podiums show confirmed completed own-race podium total and first/second/third breakdown across all loaded sessions, respecting selected game. Never count laps, practice, qualifying, others' sessions, provisional results, or duplicate session IDs. Unknown race outcomes must not display as zero podiums. Loading/error must not masquerade as zero. Use recorded result positions; no invented class positions or unsupported counts.

Extend Podiums with a sorted distribution of recorded finishing positions from fourth place onward, using exactly the same eligible races as the podium counts. Show first-, second-, and third-place counts prominently.

Keep first-, second-, and third-place trophy slots visible in every result state. Show recorded counts, including zero, when confirmed results exist; use an em dash during loading, errors, or unavailable results rather than fabricating zero.

Show the total eligible confirmed finished races beside the Podiums title, including non-podium results. Move explanatory and unavailable-result copy into accessible info-icon tooltips beside widget titles; support hover and keyboard focus while retaining visible loading/error feedback.

Replace the Practice vs race time widget with compact charts: Track distribution sums positive finite completed owned-lap seconds (valid and invalid) by gameId plus track identity, showing top tracks and Others, total hours, and shares. Consistency uses all deduplicated owned sessions in the selected game/period, ordered by `createdAt` then id, without a latest-N cap. For each session, calculate population standard deviation from at least two valid, finite, positive laps sharing its game/track/car context. Display the mean of available session deviations as headline and histogram session-deviation counts. Do not include out-of-period sessions or combine raw times across tracks/cars. Session-type bars classify Practice (including test-day), Qualifying, and Race, labeling the denominator.

Track stats automatically uses newest valid track/car context, falling back to newest recorded context when no valid lap exists; show chronological valid-lap trend and session-type time bars only for that same game/track/car. Provide no context picker. All charts use owned recorded completed laps, not idle/incomplete time or elapsed session duration.

Resolve displayed track names through one client-safe per-game helper. Reuse game registry adapters for numeric track identities (`getTrackName(number)` / `getSharedTrackName(number)`) and exact LMU catalog string identities via `getLMUTrack` / `resolveLMUTrack`; keep display/common names separate from track identity and preserve layout identity. Do not import filesystem/server `resolve-name` modules, infer prefix aliases, or default unknown IDs to a game/track. Keep unknown tracks as honest localized fallbacks. LMU catalog ID `bahrainwec_2023/bahrainwec` displays `Bahrain International Circuit`, while observed session identity `bahrainwec_2023/bahrainwec_paddock` displays exact catalog name `Bahrain Paddock Circuit` (not the base venue). Observed `Circuit de Spa-Francorchamps` identity must retain that canonical display; catalog name may match multiple layouts, so do not assume a specific layout. `commonTrackName=sakhir` is a geometry slug, not UI label. The user's `bahrainwec_2023/ba` text is truncated; do not treat it as an identity or prefix alias.

Preserve existing selected-period/game scope: `HomePageContainer` already supplies period-filtered `dashboardLaps` and `dashboardSessions` to overview insights. Do not expand to all-history data, add another filtering path, or otherwise widen upstream results. Preserve empty/loading/error states, accessibility, all 12 locales, responsive narrow-width behavior, and unrelated dashboard widgets.

### Dashboard packing refinement

Group Clean laps and Consistency vertically inside one shared surface. Use four equal-height insight groups on wide workspaces, two columns on medium workspaces, and one column on narrow workspaces. Reserve 21rem per desktop group, with internal scrolling for unusually long podium distributions; narrow layouts retain natural height. Keep all existing data, states, and tooltips accessible.

Expand the consistency histogram to ten bins: 0.1-second intervals from zero to 0.9 seconds, followed by an inclusive >=0.9-second overflow bin. Show compact lower-bound axis labels with full interval descriptions available to assistive technology and on hover. Calculate the sample and mean from every comparable session in the selected period, not the latest ten.

Verify the running dashboard at desktop and mobile widths, histogram boundary/count behavior, and repository typecheck.

### Clean-lap percentage trend

Replace the Clean laps progress bar with a chronological cumulative clean-lap percentage line chart. Each point includes all eligible timed owned laps in the selected period/game up to that timestamp; the headline and valid/total summary cover the entire selected period. Use actual timestamp spacing, a fixed 0–100% axis, cyan theme tokens, localized dates, accessible point descriptions, and a visible single point. Preserve loading/error states and show empty axes without invented data. Verify chronology, ownership/game filtering, invalid timestamps, zero timed laps, full-period coverage beyond 20 laps, and desktop/mobile rendering.

### Podium percentage trend

Show Podiums as chronological stacked bars: each confirmed finished owned race with a known positive integer finishing position contributes one bar. Stack cumulative first-, second-, and third-place shares among all eligible races in the selected period up to that timestamp; total stack height equals podium percentage, with neutral track space for other finishes. Preserve timestamp/session-ID order, deduplication, period/game scope, trophies, race totals, and finishing-position distribution. Use gold at the top for first place, silver in the middle for second, and bronze at the bottom for third, matching trophy labels. Use localized dates, a fixed 0–100% axis, keyboard bar descriptions, and horizontal scrolling for long histories. Preserve known-zero versus unavailable and loading/error states. Keep empty axes for Podiums and Clean laps without invented points, dates, or rates. Remove last-X labels and fixed sample windows from all dashboard charts, including consistency. Verify period resets, full-period coverage beyond 20 races, stack order/colors, empty/single/zero states, and desktop/mobile rendering.

## Implementation

Use period-filtered laps/sessions supplied by the dashboard container for every chart, retaining game/track/car identity and existing eligibility. Clean-lap and podium percentages accumulate chronologically across the full selected period; consistency uses all comparable deduplicated sessions with >=2 valid positive finite laps on the same game/track/car. Histogram counts use ten absolute bins. Keep the client-safe per-game label helper and registry/catalog identity rules; never import server/filesystem `resolve-name`, invent prefix aliases, or default unknown games. Preserve localized unknown labels and no context picker.

## Verification

Run focused regressions for owned identity, valid/invalid inclusion, full-period coverage beyond 10 sessions and 20 laps/races, chronology and deduplication, per-session variability sample threshold, histogram counts/mean, period resets, stacked medal colors/order, empty chart axes, session-type classification/denominator, and top-tracks-plus-Others totals. Preserve canonical label checks: exact LMU ID `bahrainwec_2023/bahrainwec` maps to `Bahrain International Circuit`, `bahrainwec_2023/bahrainwec_paddock` maps to `Bahrain Paddock Circuit` without variant collapse; observed `Circuit de Spa-Francorchamps` retains its display without forcing ambiguous layout. Unknown IDs remain localized, without server/filesystem imports or default-game behavior. Run localization compile, client typecheck, and design detector. Exercise real dashboard charts in authorized page-only browser at desktop/mobile widths, period/game changes, populated/empty/loading/error/zero/single states, keyboard bars, and long-history scrolling. Save current evidence under `.omp/evidence/podium-stacked-bars/`. No desktop/native control.

## Decision record

[Compact dashboard insight row](../adr/0003-compact-dashboard-insights.md)

