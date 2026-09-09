import type { GameId } from "@shared/games/ids";
import { tryGetGame } from "@shared/games/registry";
import { selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { stintStats } from "@shared/racing/laps/stint-stats";
import type { TuneIssue } from "@shared/racing/tuning/issues";
import type { LapMeta } from "@shared/racing/sessions/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TireGrid } from "@/components/telemetry/TireGrid";
import { SectorDetailView } from "@/components/tunes/SectorDetailView";
import { SectorMap } from "@/components/tunes/SectorMap";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, type CornerKey, METRICS, type MetricKey, tuneMetricValue } from "@/components/tunes/SectorRangeBreakdown";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { Button } from "@/components/ui/button";
import { useTirePressureOptimal } from "@/hooks/catalog-queries";
import type { ExperimentVersion, LineSpreadTrace } from "@/hooks/experiments";
import { useAlignedTelemetry } from "@/hooks/aligned-telemetry";
import { useLapIssues } from "@/hooks/tunes";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { ArmHeadline, ReviewOverviewSkeleton, ReviewTrackStats } from "./OverviewSkeleton";
import { IssuePill } from "./ReviewIssues";
import { tireSnapshotFromAlignedTrace } from "./tire-snapshot";
import { semanticTuneSamplesFromAlignedTrace, type SemanticTuneSample, wheelValue } from "../semantic-tune";
import { buildOpenLapContext } from "./open-lap-context";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { TuneReviewTrackTab } from "@/lib/game-routes";
import { TrackFocusView } from "../track-focus/TrackFocusView";

interface TuneReviewDashboardProps {
  gameId: GameId;
  trackName?: string;
  laps: LapMeta[];
  /** When set, renders a "Back to session" button in the toolbar. */
  /** Optional metadata row shown directly beneath review controls. */
  sessionLabel?: string;
  onBack?: () => void;
  /** When set, exposes direct navigation into selected lap's detailed Analyse view. */
  onDrillIntoLap?: (lap: LapMeta) => void;
  /** Keep lap selection local so session review never routes into LapAnalyse. */
  stayOnSessionReview?: boolean;
  autoSelectLap?: boolean;
  /** The version node being reviewed (resolved by the route from ?versionId or
   *  the session HEAD). Used to display its driver comment / engineer notes
   *  read-only — editing stays in VersionGraph. */
  test?: ExperimentVersion;
  /** The experiment being reviewed (from the route param). Drives the
   *  Track Focus line-spread lane + map heat. Passed straight through rather
   *  than read off `test` so it survives an orphaned/missing test row. */
  experimentId?: number | null;
  lineSpread?: LineSpreadTrace | null;
  /** Fires whenever the compact text summary of the currently-open lap review
   *  changes (lap switch, sector telemetry load, metric change, etc.) — lets a
   *  parent pipe "what the user is currently looking at" into the Setup
   *  Engineer chat's request context. Fires with `null` when nothing is open
   *  (no laps yet). */
  onOpenLapContextChange?: (text: string | null) => void;
}

type SectorView = `s${number}`;
type ReviewView = "overview" | "track" | "analyse" | SectorView;

/**
 * TuneReviewDashboard — post-lap analysis for a finished lap, in the "sector
 * spine" layout: the session's sectors are the organising columns (time + where on
 * track), then the lap's detected issues, tyre state, and the Setup Engineer
 * recommendation. Everything is reconstructed from the selected lap's stored
 * telemetry — no live stream.
 */
export function SessionReviewDashboard({
  gameId,
  trackName,
  laps,
  onBack,
  onDrillIntoLap,
  sessionLabel,
  stayOnSessionReview = false,
  autoSelectLap = true,
  test,
  experimentId,
  lineSpread,
  onOpenLapContextChange,
}: TuneReviewDashboardProps) {
  const validLaps = useMemo(() => [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber), [laps]);
  const evaluationLaps = useMemo(() => selectEvaluationLaps(laps).chosen, [laps]);
  const evaluationLapIds = useMemo(() => evaluationLaps.map((lap) => lap.id), [evaluationLaps]);
  const bestLap = useMemo(() => validLaps.reduce<LapMeta | null>((best, lap) => (best == null || lap.lapTime < best.lapTime ? lap : best), null), [validLaps]);
  const aligned = useAlignedTelemetry(evaluationLapIds, evaluationLapIds.length ? { step: 1 } : null);

  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { lap?: number; view?: ReviewView; tab?: TuneReviewTrackTab };
  const [reviewLapId, setReviewLapId] = useState<number | null>(null);
  const selectedLapId = stayOnSessionReview ? reviewLapId : search.lap;
  const focusLap = evaluationLaps.find((l) => l.id === selectedLapId) ?? evaluationLaps[0];
  const view = search.view ?? "overview";
  const isTrackView = view === "track" || view === "analyse";
  const tab = search.tab ?? "consistency";
  useEffect(() => {
    if (!stayOnSessionReview || search.view !== "track") return;
    void navigate({ replace: true, search: (previous: Record<string, unknown>) => ({ ...previous, view: "analyse" }) } as never);
  }, [navigate, search.view, stayOnSessionReview]);
  const lapOptions = useMemo(
    () => [
      ...(stayOnSessionReview || isTrackView ? [{ value: "all", label: bestLap ? `Primary lap (Lap ${bestLap.lapNumber})` : "Primary lap" }] : []),
      ...evaluationLaps.map((l) => ({ value: String(l.id), label: `Lap ${l.lapNumber} — ${formatLapTime(l.lapTime)}` })),
    ],
    [bestLap, isTrackView, stayOnSessionReview, evaluationLaps],
  );
  const setFocus = useCallback(
    (id: number) => {
      if (stayOnSessionReview) setReviewLapId(id);
      else void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, lap: id }) } as never);
    },
    [navigate, stayOnSessionReview],
  );
  const setTrackTab = useCallback(
    (nextTab: TuneReviewTrackTab) => {
      void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, view: stayOnSessionReview ? "analyse" : "track", tab: nextTab }) } as never);
    },
    [navigate, stayOnSessionReview],
  );
  useEffect(() => {
    if (stayOnSessionReview || !autoSelectLap || evaluationLaps.length === 0) return;
    if (isTrackView && search.lap == null) return;
    if (evaluationLaps.some((l) => l.id === search.lap)) return;
    navigate({ replace: true, search: (previous: Record<string, unknown>) => ({ ...previous, lap: evaluationLaps[0]!.id }) } as never);
  }, [autoSelectLap, isTrackView, navigate, search.lap, stayOnSessionReview, evaluationLaps]);
  const selectedTrace = aligned.data?.laps.find((trace) => trace.lapId === focusLap?.id);
  const telemetry = useMemo(
    () => (selectedTrace ? semanticTuneSamplesFromAlignedTrace(selectedTrace, gameId, focusLap?.trackOrdinal, aligned.data?.nominalSpanMeters ?? 0) : []),
    [aligned.data, focusLap?.trackOrdinal, focusLap?.id, gameId, selectedTrace],
  );
  const sectorTimes = selectedTrace?.sectorTimes
    ? (() => {
        const times = selectedTrace.sectorTimes!;
        const starts = (selectedTrace.sectorStarts ?? []).filter((start) => Number.isFinite(start) && start > 0 && start < 1).slice(0, Math.max(0, times.length - 1));
        const boundaryIndices =
          starts.length === times.length - 1
            ? starts.map((start) => Math.round(start * Math.max(0, telemetry.length - 1)))
            : Array.from({ length: Math.max(0, times.length - 1) }, (_, index) => Math.round(((index + 1) * Math.max(0, telemetry.length - 1)) / times.length));
        return { times, boundaryIndices };
      })()
    : null;
  const sectorCount = sectorTimes?.times.length ?? 3;
  const corners = useMemo(() => (selectedTrace ? tireSnapshotFromAlignedTrace(selectedTrace) : null), [selectedTrace]);
  const game = tryGetGame(gameId);
  const tireHealthAvailable = telemetry.some((sample) => wheelValue(sample, "tireWearFraction", 0) != null);
  const [metricKey, setMetricKey] = useState<MetricKey>("tyreTemp");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const reviewStats = useMemo(() => stintStats(evaluationLaps, { dropOutLap: false }), [evaluationLaps]);
  const ranges = useMemo(() => buildSectorRanges(telemetry, sectorTimes, metric), [telemetry, sectorTimes, metric]);
  const { data: issues } = useLapIssues(focusLap?.id ?? null);
  const pressureOptimal = useTirePressureOptimal(gameId, focusLap?.carOrdinal);

  // no position (lap-wide, e.g. average tyre pressure) go to the whole-lap strip.
  const issueGroups = useMemo(() => {
    const count = sectorTimes?.times.length ?? 3;
    const bySector: TuneIssue[][] = Array.from({ length: count }, () => []);
    const wholeLap: TuneIssue[] = [];
    const len = telemetry.length;
    const boundaries = sectorTimes && len > 1 ? sectorTimes.boundaryIndices.map((index) => index / (len - 1)) : Array.from({ length: count - 1 }, (_, index) => (index + 1) / count);
    for (const it of issues ?? []) {
      if (it.distanceFrac == null) {
        wholeLap.push(it);
        continue;
      }
      const sector = boundaries.findIndex((boundary) => it.distanceFrac! < boundary);
      bySector[sector < 0 ? count - 1 : sector].push(it);
    }
    return { bySector, wholeLap };
  }, [issues, telemetry.length, sectorTimes]);
  const issueMarkers = useMemo(() => {
    const seen = new Set<number>();
    return (issues ?? []).flatMap((issue) => {
      const fraction = issue.distanceFrac;
      if (fraction == null || !Number.isFinite(fraction) || seen.has(fraction)) return [];
      seen.add(fraction);
      const color = issue.severity === "critical" ? "var(--status-danger)" : issue.severity === "warn" ? "var(--status-warning)" : "var(--status-info)";
      return [{ fraction, color }];
    });
  }, [issues]);

  // Hover position: which sector column is being scrubbed, and the frame index.
  // Only the hovered sector's bars show the cursor line.
  const [hoverPos, setHoverPos] = useState<{ sector: number; idx: number } | null>(null);
  // An issue's location, marked on its sector map while its list item is hovered.
  const [markedIssue, setMarkedIssue] = useState<{ sector: number; frac: number } | null>(null);
  const requestedSector = /^s([1-9]\d*)$/.exec(view)?.[1];
  const parsedSectorIndex = requestedSector ? Number(requestedSector) - 1 : null;
  const sectorIndex = parsedSectorIndex != null && parsedSectorIndex < sectorCount ? parsedSectorIndex : null;
  const setView = (nextView: ReviewView) =>
    navigate({
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        view: nextView === "overview" ? undefined : stayOnSessionReview && nextView === "track" ? "analyse" : nextView,
        lap: stayOnSessionReview ? undefined : nextView === "track" ? undefined : typeof previous.lap === "number" ? previous.lap : focusLap?.id,
      }),
    } as never);
  // In the track view, no ?lap= means "Best lap"; a stale id also counts as Best lap.
  const trackFocusId =
    isTrackView && (stayOnSessionReview ? reviewLapId : evaluationLaps.some((l) => l.id === search.lap) ? search.lap : null) ? (stayOnSessionReview ? reviewLapId : search.lap) : null;
  const cursor = useMemo(() => {
    if (!hoverPos) return undefined;
    const f = telemetry[hoverPos.idx];
    if (!f) return undefined;
    return Object.fromEntries(CORNERS.map((corner, index) => [corner, tuneMetricValue(f, metric, index)]).filter(([, value]) => value !== undefined)) as Partial<Record<CornerKey, number>>;
  }, [hoverPos, telemetry, metric.key]);

  // Hover readout for the map: the selected metric's four corner values at the
  // cursor's point on the lap.
  const readout = useCallback(
    (frame: SemanticTuneSample) => {
      return CORNERS.map((corner, index) => {
        const value = tuneMetricValue(frame, metric, index);
        return {
          label: corner,
          value: value === undefined ? "—" : `${value.toFixed(metric.key === "wear" ? 0 : 1)} ${metric.unit}`,
          color: value === undefined ? undefined : metric.semantic ? bandColor(value) : metric.accent,
        };
      });
    },
    [metric],
  );
  // the Setup Engineer chat "what the user currently sees" (rebuilt whenever
  // any of this changes, not captured once).
  const openLapContext = useMemo(
    () =>
      buildOpenLapContext({
        focusLap,
        sectorTimes,
        laps,
        corners,
        issues,
        ranges,
        metric,
        test,
        cornerKeys: CORNERS,
      }),
    [focusLap, sectorTimes, laps, corners, issues, ranges, metric, test],
  );

  useEffect(() => {
    onOpenLapContextChange?.(openLapContext);
  }, [openLapContext, onOpenLapContextChange]);

  // No focus lap yet (empty session / ?laps= with nothing recorded): render the
  // overview skeleton — same spine layout, placeholder times/maps — so the page
  // reads as the review dashboard rather than a bare "no laps" message.
  if (!focusLap) {
    return <ReviewOverviewSkeleton trackName={trackName} onBack={onBack} />;
  }

  const isOverview = !isTrackView && sectorIndex == null;

  return (
    <div className={`flex h-full min-h-0 flex-col ${!isTrackView ? "overflow-y-auto" : ""}`}>
      {/* Header and detail content share one page scroll in Overview and Sector
          views; Track keeps its own internal panel layout. */}
      <div className="flex-none bg-app-bg">
        {/* Toolbar: lap picker + view switcher on the left, Setup Engineer on the right */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
          {onBack && (
            <Button variant="app-outline" size="app-sm" onClick={onBack}>
              ← Session
            </Button>
          )}
          <SearchSelect
            value={
              stayOnSessionReview && !isTrackView
                ? reviewLapId != null
                  ? String(reviewLapId)
                  : "all"
                : isTrackView
                  ? trackFocusId != null
                    ? String(trackFocusId)
                    : "all"
                  : String(focusLap.id)
            }
            onChange={(value) => {
              if (value === "all") {
                if (stayOnSessionReview) setReviewLapId(null);
                else void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, lap: undefined }) } as never);
              } else {
                setFocus(Number(value));
              }
            }}
            options={lapOptions}
            ariaLabel="Select lap"
            className="w-56"
          />
          {onDrillIntoLap && focusLap && (!stayOnSessionReview || reviewLapId != null) && (
            <Button variant="app-outline" size="app-sm" onClick={() => onDrillIntoLap(focusLap)}>
              {m.analyse_lap_button()}
            </Button>
          )}
          {!(stayOnSessionReview && reviewLapId == null) && !(isTrackView && trackFocusId == null) && (
            <span className="text-status-success text-sm" title="valid lap">
              ✓
            </span>
          )}
          {sessionLabel && <span className="ml-auto text-xs text-app-text-dim">Showing up to five fastest clean laps.</span>}
          <div className="ml-auto flex gap-1">
            {(["overview", ...Array.from({ length: sectorCount }, (_, index) => `s${index + 1}` as SectorView), stayOnSessionReview ? "analyse" : "track"] as ReviewView[]).map((v) => (
              <Button
                key={v}
                variant="app-ghost"
                size="app-sm"
                onClick={() => setView(v)}
                className={`!border text-xs ${(view === v || (stayOnSessionReview && v === "analyse" && isTrackView)) ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
              >
                {v === "overview" ? "Overview" : v === "track" || v === "analyse" ? m.label_analyse() : `Sector ${v.slice(1)}`}
              </Button>
            ))}
          </div>
        </div>

        {test && <ArmHeadline kind={test.kind} laps={validLaps} />}
        {isOverview && <ReviewTrackStats stats={reviewStats} issueCount={issues?.length ?? 0} />}

        {(test?.driverComment || test?.notes) && (
          <div className="border-b border-app-border px-4 py-2.5 space-y-2">
            {test?.driverComment && (
              <div>
                <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Driver comment</div>
                <div className="text-xs text-app-text whitespace-pre-wrap">{test.driverComment}</div>
              </div>
            )}
            {test?.notes && (
              <div>
                <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Engineer notes</div>
                <div className="text-xs text-app-text whitespace-pre-wrap">{test.notes}</div>
              </div>
            )}
          </div>
        )}

        {/* Sector spine (Overview only) — the "track display" itself, kept inside
          the sticky header so it and everything above it pin together. */}
        {isOverview && (
          <div className="border-b border-app-border">
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-app-border">
              <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">{sessionLabel}</span>
              <div className="flex gap-1 flex-wrap justify-end">
                {METRICS.map((m) => (
                  <Button
                    key={m.key}
                    variant="app-ghost"
                    size="app-sm"
                    onClick={() => setMetricKey(m.key)}
                    className={`!border text-app-compact ${m.key === metricKey ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
                  >
                    {m.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 @3xl/workspace:grid-cols-2">
              <div className="min-w-0 border-b border-app-border @3xl/workspace:border-b-0 @3xl/workspace:border-r aspect-square">
                {telemetry.length > 0 ? (
                  <SectorMap
                    gameId={gameId}
                    telemetry={telemetry}
                    sectorTimes={sectorTimes}
                    showTimes={false}
                    trackOrdinal={focusLap.trackOrdinal}
                    issueMarkers={issueMarkers}
                    readout={readout}
                    onHover={(idx) => setHoverPos(idx == null ? null : { sector: -1, idx })}
                    markFraction={markedIssue ? markedIssue.frac : null}
                  />
                ) : (
                  <div className="p-4 text-xs text-app-text-dim">{aligned.isLoading ? "Loading…" : "No telemetry"}</div>
                )}
              </div>
              <div className="min-w-0 divide-y divide-app-border">
                {Array.from({ length: sectorCount }, (_, i) => `S${i + 1}`).map((label, i) => (
                  <div key={label} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3 p-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="h-1 w-6 rounded" style={{ background: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
                        <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">{label}</span>
                      </div>
                      <div className="mt-1 text-sm font-mono tabular-nums text-app-text">{sectorTimes && sectorTimes.times[i] > 0 ? formatLapTime(sectorTimes.times[i]) : "—"}</div>
                    </div>
                    {ranges ? (
                      <CornerBars ranges={ranges.sectors[i]} domain={ranges.domain} metric={metric} cursor={hoverPos?.sector === i ? cursor : undefined} />
                    ) : (
                      <div className="text-xs text-app-text-dim">No telemetry</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {ranges && (
              <div className="px-4 py-1.5 text-app-compact text-app-text-dim border-t border-app-border">
                {metric.label}: bars span min→max, tick = average · shared scale {Math.round(ranges.domain[0])}–{Math.round(ranges.domain[1])} {metric.unit}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail body — track panels own their internal scroll; other views use the body scroll. */}
      <div className={`min-h-0 ${isTrackView ? "flex-1 overflow-hidden" : "flex-none overflow-visible"}`}>
        {isTrackView ? (
          <TrackFocusView
            gameId={gameId}
            laps={evaluationLaps}
            alignedSet={aligned.data}
            evaluationLapIds={evaluationLapIds}
            trackOrdinal={focusLap.trackOrdinal}
            focusLapId={trackFocusId}
            onFocusLap={setFocus}
            experimentId={experimentId ?? test?.experimentId ?? null}
            lineSpreadOverride={lineSpread}
            activeTab={tab}
            onActiveTabChange={setTrackTab}
          />
        ) : sectorIndex != null ? (
          <SectorDetailView gameId={gameId} telemetry={telemetry} sectorTimes={sectorTimes} sectorIndex={sectorIndex} trackOrdinal={focusLap.trackOrdinal} issues={issueGroups.bySector[sectorIndex]} />
        ) : (
          <>
            {/* Detected issues, laid out per sector */}
            <div className="border-b border-app-border">
              <div className="px-4 pt-3 pb-1 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Detected from telemetry</div>
              {!issues ? (
                <div className="px-4 pb-3 text-xs text-app-text-dim">Loading issues…</div>
              ) : issues.length === 0 ? (
                <div className="px-4 pb-3 text-xs text-app-text-dim">No handling or tyre issues detected on this lap.</div>
              ) : (
                <>
                  {issueGroups.wholeLap.length > 0 && (
                    <div className="px-4 pb-2">
                      <div className="text-app-caption text-app-text-dim uppercase tracking-wider mb-1">Whole lap</div>
                      <div className="flex flex-col gap-1">
                        {issueGroups.wholeLap.map((it) => (
                          <IssuePill key={`${it.kind}-${it.corner ?? ""}-${it.detail}`} issue={it} />
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 @3xl/workspace:auto-cols-fr @3xl/workspace:grid-flow-col">
                    {Array.from({ length: sectorCount }, (_, i) => `S${i + 1}`).map((label, i) => (
                      <div key={label} className={`border-t border-app-border px-3 py-2 @3xl/workspace:border-t-0 ${i < sectorCount - 1 ? "border-app-border @3xl/workspace:border-r" : ""}`}>
                        <div className="sticky top-0 z-10 flex items-center gap-1.5 mb-1.5 bg-app-bg">
                          <span className="w-3 h-1 rounded" style={{ background: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
                          <span className="text-app-caption text-app-text-muted uppercase tracking-wider">Sector {i + 1}</span>
                        </div>
                        {issueGroups.bySector[i].length === 0 ? (
                          <div className="text-app-compact text-app-text-dim">No issues</div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {issueGroups.bySector[i].map((it) => (
                              <IssuePill key={`${it.kind}-${it.corner ?? ""}-${it.detail}`} issue={it} onHover={(f) => setMarkedIssue(f == null ? null : { sector: i, frac: f })} />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Tyres */}
            <div>
              <div>
                {corners ? (
                  <TireGrid
                    title={m.analyse_tires_end_of_lap()}
                    corners={corners}
                    healthThresholds={game?.tireHealthThresholds ?? { green: 0.85, yellow: 0.7 }}
                    tempThresholds={{ blue: 70, orange: 100, red: 110 }}
                    pressureOptimal={pressureOptimal}
                    brakeTempThresholds={game?.brakeTempThresholds}
                    healthAvailable={tireHealthAvailable}
                  />
                ) : (
                  <div className="p-3 text-xs text-app-text-dim">{aligned.isLoading ? "Loading tyre state…" : "No stored telemetry for this lap."}</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
