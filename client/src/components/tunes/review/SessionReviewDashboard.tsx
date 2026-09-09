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
import { SessionLapSelectionDialog } from "./SessionLapSelectionDialog";
import { Button } from "@/components/ui/button";
import { useTirePressureOptimal } from "@/hooks/catalog-queries";
import type { ExperimentVersion, LineSpreadTrace } from "@/hooks/experiments";
import { useSessionLineSpread } from "@/hooks/laps";
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
  sessionId?: number;
  /** When set, renders a "Back to session" button in the toolbar. */
  /** Optional metadata row shown directly beneath review controls. */
  sessionLabel?: string;
  onBack?: () => void;
  onDrillIntoLap?: (lap: LapMeta) => void;
  stayOnSessionReview?: boolean;
  autoSelectLap?: boolean;
  test?: ExperimentVersion;
  experimentId?: number | null;
  lineSpread?: LineSpreadTrace | null;
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
  sessionId,
  onBack,
  onDrillIntoLap,
  sessionLabel,
  stayOnSessionReview = false,
  test,
  experimentId,
  lineSpread,
  onOpenLapContextChange,
}: TuneReviewDashboardProps) {
  const validLaps = useMemo(() => [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber), [laps]);
  const evaluationLaps = useMemo(() => selectEvaluationLaps(laps).chosen, [laps]);
  const fallbackLaps = useMemo(() => [...laps].sort((a, b) => a.lapNumber - b.lapNumber).slice(0, 5), [laps]);
  const search = useSearch({ strict: false }) as { lap?: number; laps?: string; primary?: number; view?: ReviewView; tab?: TuneReviewTrackTab };
  const requestedIds = search.laps?.split(",").map(Number);
  const defaultDisplayedLaps = evaluationLaps.length > 0 ? evaluationLaps : fallbackLaps;
  const displayedLaps = stayOnSessionReview ? (requestedIds && requestedIds.every(Number.isInteger) ? laps.filter((lap) => requestedIds.includes(lap.id)) : defaultDisplayedLaps) : evaluationLaps;
  const displayedLapIds = useMemo(() => displayedLaps.map((lap) => lap.id), [displayedLaps]);
  const selectionInvalid = stayOnSessionReview && (requestedIds != null && (requestedIds.length === 0 || requestedIds.length > 5 || requestedIds.some((id) => !Number.isInteger(id) || id <= 0) || displayedLaps.length !== requestedIds.length || (search.primary != null && !requestedIds.includes(search.primary))));
  const primaryLapId = stayOnSessionReview ? (selectionInvalid ? 0 : search.primary ?? displayedLaps[0]?.id ?? 0) : evaluationLaps[0]?.id ?? 0;
  const primaryLap = displayedLaps.find((lap) => lap.id === primaryLapId) ?? displayedLaps[0];
  const aligned = useAlignedTelemetry(selectionInvalid ? [] : displayedLapIds, selectionInvalid ? null : displayedLapIds.length ? { step: 1 } : null);
  const sessionSpread = useSessionLineSpread(
    sessionId ?? null,
    selectionInvalid ? [] : displayedLapIds,
    stayOnSessionReview && (search.view === "track" || search.view === "analyse") && (search.tab ?? "consistency") === "consistency",
  );
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const selectedLapId = stayOnSessionReview ? (primaryLap?.id ?? null) : search.lap;
  const focusLap = displayedLaps.find((l) => l.id === selectedLapId) ?? primaryLap;
  const view = search.view ?? "overview";
  const isTrackView = view === "track" || view === "analyse";
  const tab = search.tab ?? "consistency";
  const bestLap = useMemo(() => validLaps.reduce<LapMeta | null>((best, lap) => (best == null || lap.lapTime < best.lapTime ? lap : best), null), [validLaps]);
  const lapOptions = useMemo(() => [...(isTrackView ? [{ value: "all", label: bestLap ? `Primary lap (Lap ${bestLap.lapNumber})` : "Primary lap" }] : []), ...evaluationLaps.map((l) => ({ value: String(l.id), label: `Lap ${l.lapNumber} — ${formatLapTime(l.lapTime)}` }))], [bestLap, isTrackView, evaluationLaps]);
  const setFocus = useCallback((id: number) => { void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, lap: id }) } as never); }, [navigate]);
  const setTrackTab = useCallback((nextTab: TuneReviewTrackTab) => { void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, view: stayOnSessionReview ? "analyse" : "track", tab: nextTab }) } as never); }, [navigate, stayOnSessionReview]);
  useEffect(() => {
    if (!stayOnSessionReview || search.laps != null || displayedLaps.length === 0) return;
    void navigate({ replace: true, search: (previous: Record<string, unknown>) => ({ ...previous, laps: displayedLapIds.join(","), primary: displayedLapIds[0] }) } as never);
  }, [displayedLapIds, displayedLaps.length, navigate, search.laps, stayOnSessionReview]);
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
  const reviewStats = useMemo(() => stintStats(displayedLaps, { dropOutLap: false }), [displayedLaps]);
  const [metricKey, setMetricKey] = useState<MetricKey>("tyreTemp");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
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
    <div className="flex min-h-full flex-col">
      {/* ResponsiveWorkspace owns vertical scrolling for every review view. */}
      {/* Toolbar: lap picker + view switcher on the left, Setup Engineer on the right */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-app-border bg-app-bg px-4 py-2.5">
          {onBack && (
            <Button variant="app-outline" size="app-sm" onClick={onBack}>
              ← Session
            </Button>
          )}
          {stayOnSessionReview ? (
            <Button variant="app-outline" size="app-sm" onClick={() => setDialogOpen(true)}>
              Laps: {displayedLaps.length} · Primary: Lap {primaryLap?.lapNumber ?? "—"}
            </Button>
          ) : (
            <SearchSelect
              value={isTrackView ? String(focusLap.id) : String(focusLap.id)}
              onChange={(value) => setFocus(Number(value))}
              options={lapOptions}
              ariaLabel="Select lap"
              className="w-56"
            />
          )}
          {onDrillIntoLap && focusLap && (
            <Button variant="app-outline" size="app-sm" onClick={() => onDrillIntoLap(focusLap)}>
              {m.analyse_lap_button()}
            </Button>
          )}
          {focusLap && <span className={`text-sm ${focusLap.isValid ? "text-status-success" : "text-status-danger"}`} title={focusLap.isValid ? "valid lap" : "invalid lap"}>{focusLap.isValid ? "✓" : "!"}</span>}
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
      <div className="flex-none bg-app-bg">
        {aligned.isError && !selectionInvalid && <p role="alert" className="border-b border-app-border px-4 py-2 text-sm text-status-danger">Could not load selected laps.</p>}
        {selectionInvalid && <p role="alert" className="border-b border-app-border px-4 py-2 text-sm text-status-danger">Selected laps must belong to this session.</p>}

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

      {/* Detail body participates in the page scroll. */}
      <div className="min-h-0 flex-none overflow-visible">
        {isTrackView ? (
          <TrackFocusView
            gameId={gameId}
            alignedSet={aligned.data}
            lapIds={displayedLapIds}
            trackOrdinal={focusLap.trackOrdinal}
            primaryLapId={primaryLapId}
            experimentId={experimentId ?? test?.experimentId ?? null}
            activeTab={tab}
            lineSpreadOverride={sessionSpread.data ?? lineSpread}
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
      {stayOnSessionReview && (
        <SessionLapSelectionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          laps={laps}
          selectedLapIds={displayedLapIds}
          primaryLapId={primaryLapId}
          onApply={({ lapIds, primaryLapId: nextPrimary }) =>
            void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, laps: lapIds.join(","), primary: nextPrimary }) } as never)
          }
        />
      )}
    </div>
  );
}
