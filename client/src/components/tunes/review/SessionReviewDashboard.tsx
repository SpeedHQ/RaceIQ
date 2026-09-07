import type { GameId } from "@shared/games/ids";
import { tryGetGame } from "@shared/games/registry";
import type { TuneIssue } from "@shared/racing/tuning/issues";
import type { LapMeta } from "@shared/racing/sessions/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TireGrid } from "@/components/telemetry/TireGrid";
import { SectorDetailView } from "@/components/tunes/SectorDetailView";
import { SectorMap } from "@/components/tunes/SectorMap";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, type CornerKey, METRICS, type MetricKey, tuneMetricValue } from "@/components/tunes/SectorRangeBreakdown";
import { Button } from "@/components/ui/button";
import { useTirePressureOptimal } from "@/hooks/catalog-queries";
import type { ExperimentVersion, LineSpreadTrace } from "@/hooks/experiments";
import { useLapSemanticTelemetry } from "@/hooks/laps";
import { useLapIssues } from "@/hooks/tunes";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { ArmHeadline, ReviewOverviewSkeleton } from "./OverviewSkeleton";
import { IssuePill } from "./ReviewIssues";
import { tireSnapshot } from "./tire-snapshot";
import { semanticSamples, type SemanticTuneSample, wheelValue } from "../semantic-tune";
import { buildOpenLapContext } from "./open-lap-context";
import { TrackFocusView } from "../track-focus/TrackFocusView";

interface TuneReviewDashboardProps {
  gameId: GameId;
  trackName?: string;
  laps: LapMeta[];
  /** When set, renders a "Back to session" button in the toolbar. */
  onBack?: () => void;
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
type ReviewView = "overview" | "track" | SectorView;
type TrackTab = "consistency" | "tires" | "balance" | "suspension";

/**
 * TuneReviewDashboard — post-lap analysis for a finished lap, in the "sector
 * spine" layout: the session's sectors are the organising columns (time + where on
 * track), then the lap's detected issues, tyre state, and the Setup Engineer
 * recommendation. Everything is reconstructed from the selected lap's stored
 * telemetry — no live stream.
 */
export function SessionReviewDashboard({ gameId, trackName, laps, onBack, stayOnSessionReview = false, autoSelectLap = true, test, experimentId, lineSpread, onOpenLapContextChange }: TuneReviewDashboardProps) {
  const validLaps = useMemo(() => [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber), [laps]);

  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { lap?: number; view?: ReviewView; trackTab?: TrackTab };
  const [reviewLapId, setReviewLapId] = useState<number | null>(null);
  const selectedLapId = stayOnSessionReview ? reviewLapId : search.lap;
  const focusLap = validLaps.find((l) => l.id === selectedLapId) ?? validLaps[0];
  const view = search.view ?? "overview";
  const trackTab = search.trackTab ?? "consistency";
  const setFocus = useCallback((id: number) => {
    if (stayOnSessionReview) setReviewLapId(id);
    else void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, lap: id }) } as never);
  }, [navigate, stayOnSessionReview]);
  const setTrackTab = useCallback((tab: TrackTab) => {
    void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, view: "track", trackTab: tab }) } as never);
  }, [navigate]);

  // Point the URL at a real lap when it's missing or stale for this session.
  // The track view is stint-wide: a missing ?lap= there means "All", so leave it.
  useEffect(() => {
    if (stayOnSessionReview || !autoSelectLap || validLaps.length === 0) return;
    if (search.view === "track" && search.lap == null) return;
    if (validLaps.some((l) => l.id === search.lap)) return;
    navigate({ replace: true, search: (previous: Record<string, unknown>) => ({ ...previous, lap: validLaps[0].id }) } as never);
  }, [autoSelectLap, navigate, search.lap, search.view, stayOnSessionReview, validLaps]);
  const { data: lapTel, isLoading: loadingTel } = useLapSemanticTelemetry(view === "track" ? null : focusLap?.id ?? null);
  const { data: issues } = useLapIssues(focusLap?.id ?? null);
  const pressureOptimal = useTirePressureOptimal(gameId, focusLap?.carOrdinal);

  const telemetry = useMemo(() => semanticSamples(gameId, lapTel?.envelopes), [gameId, lapTel]);
  const sectorTimes = lapTel?.sectorTimes ? { times: lapTel.sectorTimes, boundaryIndices: lapTel.sectorStarts ?? [] } : null;
  const sectorCount = sectorTimes?.times.length ?? 3;
  const corners = useMemo(() => tireSnapshot(telemetry), [telemetry]);
  const game = tryGetGame(gameId);
  const tireHealthAvailable = telemetry.some((sample) => wheelValue(sample, "tireWearFraction", 0) != null);

  const [metricKey, setMetricKey] = useState<MetricKey>("tyreTemp");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const ranges = useMemo(() => buildSectorRanges(telemetry, sectorTimes, metric), [telemetry, sectorTimes, metric]);
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
        view: nextView === "overview" ? undefined : nextView,
        lap: stayOnSessionReview ? undefined : nextView === "track" ? undefined : (typeof previous.lap === "number" ? previous.lap : focusLap?.id),
      }),
    } as never);
  // In the track view, no ?lap= means "All laps"; a stale id also counts as All.
  const trackFocusId = view === "track" && (stayOnSessionReview ? reviewLapId : validLaps.some((l) => l.id === search.lap) ? search.lap : null) ? (stayOnSessionReview ? reviewLapId : search.lap) : null;
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

  const isOverview = view !== "track" && sectorIndex == null;

  return (
    <div className="flex flex-col h-[calc(100vh-5.5rem)]">
      {/* Static header — toolbar, driver/engineer notes, and (in Overview) the
          sector "track display". Stays put; it does NOT scroll over the detail
          body — instead the issues / tyres content owns its own scroll below. */}
      <div className="flex-none bg-app-bg">
        {/* Toolbar: lap picker + view switcher on the left, Setup Engineer on the right */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
          {onBack && (
            <Button variant="app-outline" size="app-sm" onClick={onBack}>
              ← Session
            </Button>
          )}
          <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Post-lap</span>
          <select
            value={stayOnSessionReview && view !== "track" ? (reviewLapId ?? "all") : view === "track" ? (trackFocusId ?? "all") : focusLap.id}
            onChange={(e) => {
              if (e.target.value === "all") {
                if (stayOnSessionReview) setReviewLapId(null);
                else navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, lap: undefined }) } as never);
              } else {
                setFocus(Number(e.target.value));
              }
            }}
          >
            {(stayOnSessionReview || view === "track") && <option value="all">All laps</option>}
            {validLaps.map((l) => (
              <option key={l.id} value={l.id}>
                Lap {l.lapNumber} — {l.lapTime.toFixed(3)}s
              </option>
            ))}
          </select>
          {!(stayOnSessionReview && reviewLapId == null) && !(view === "track" && trackFocusId == null) && (
            <span className="text-status-success text-sm" title="valid lap">
              ✓
            </span>
          )}
          <div className="flex gap-1">
            {(["overview", ...Array.from({ length: sectorCount }, (_, index) => `s${index + 1}` as SectorView), "track"] as ReviewView[]).map((v) => (
              <Button
                key={v}
                variant="app-ghost"
                size="app-sm"
                onClick={() => setView(v)}
                className={`!border text-xs ${view === v ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
              >
                {v === "overview" ? "Overview" : v === "track" ? "Track" : `Sector ${v.slice(1)}`}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">{trackName && <span className="hidden text-xs text-app-text-muted @5xl/workspace:inline">{trackName}</span>}</div>
        </div>

        {test && <ArmHeadline kind={test.kind} laps={validLaps} />}

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
              <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sectors</span>
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
            <div className="grid grid-cols-1 gap-3 p-3 @3xl/workspace:grid-cols-[minmax(0,0.9fr)_minmax(22rem,1.1fr)]">
              <div className="min-w-0 rounded border border-app-border bg-app-surface/20">
                {telemetry.length > 0 ? (
                  <SectorMap
                    telemetry={telemetry}
                    sectorTimes={sectorTimes}
                    showTimes={false}
                    trackOrdinal={focusLap.trackOrdinal}
                    readout={readout}
                    onHover={(idx) => setHoverPos(idx == null ? null : { sector: -1, idx })}
                    markFraction={markedIssue ? markedIssue.frac : null}
                  />
                ) : (
                  <div className="p-4 text-xs text-app-text-dim">{loadingTel ? "Loading…" : "No telemetry"}</div>
                )}
              </div>
              <div className="min-w-0 divide-y divide-app-border rounded border border-app-border bg-app-surface/20">
                {Array.from({ length: sectorCount }, (_, i) => `S${i + 1}`).map((label, i) => (
                  <div key={label} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3 p-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="h-1 w-6 rounded" style={{ background: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
                        <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">{label}</span>
                      </div>
                      <div className="mt-1 text-sm font-mono tabular-nums text-app-text">{sectorTimes && sectorTimes.times[i] > 0 ? sectorTimes.times[i].toFixed(3) : "—"}</div>
                    </div>
                    {ranges ? <CornerBars ranges={ranges.sectors[i]} domain={ranges.domain} metric={metric} cursor={hoverPos?.sector === i ? cursor : undefined} /> : <div className="text-xs text-app-text-dim">No telemetry</div>}
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

      {/* Detail body — owns its own scroll; the header above stays static. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === "track" ? (
          <TrackFocusView
            gameId={gameId}
            laps={laps}
            trackOrdinal={focusLap.trackOrdinal}
            focusLapId={trackFocusId}
            onFocusLap={setFocus}
            experimentId={experimentId ?? test?.experimentId ?? null}
            lineSpreadOverride={lineSpread}
            activeTab={trackTab}
            onActiveTabChange={setTrackTab}
          />
        ) : sectorIndex != null ? (
          <SectorDetailView telemetry={telemetry} sectorTimes={sectorTimes} sectorIndex={sectorIndex} trackOrdinal={focusLap.trackOrdinal} issues={issueGroups.bySector[sectorIndex]} />
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
                      <div className="flex flex-wrap gap-2">
                        {issueGroups.wholeLap.map((it) => (
                          <IssuePill key={`${it.kind}-${it.corner ?? ""}-${it.detail}`} issue={it} />
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 @3xl/workspace:auto-cols-fr @3xl/workspace:grid-flow-col">
                    {Array.from({ length: sectorCount }, (_, i) => `S${i + 1}`).map((label, i) => (
                      <div key={label} className={`border-t border-app-border px-3 py-2 @3xl/workspace:border-t-0 ${i < sectorCount - 1 ? "border-app-border @3xl/workspace:border-r" : ""}`}>
                        <div className="flex items-center gap-1.5 mb-1.5">
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
              <div className="px-3 pt-3 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Tyres · end of lap</div>
              <div>
                {corners ? (
                  <TireGrid
                    corners={corners}
                    healthThresholds={game?.tireHealthThresholds ?? { green: 0.85, yellow: 0.7 }}
                    tempThresholds={{ blue: 70, orange: 100, red: 110 }}
                    pressureOptimal={pressureOptimal}
                    brakeTempThresholds={game?.brakeTempThresholds}
                    healthAvailable={tireHealthAvailable}
                  />
                ) : (
                  <div className="p-3 text-xs text-app-text-dim">{loadingTel ? "Loading tyre state…" : "No stored telemetry for this lap."}</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
