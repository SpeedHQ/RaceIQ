import { headlineMetricForVersionKind, type VersionKind } from "@shared/experiment-focus";
import { tryGetGame } from "@shared/games/registry";
import type { LapMeta, TelemetryPacket, TuneIssue } from "@shared/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import type { ExperimentVersion } from "../../hooks/queries";
import { useLapIssues, useLapTelemetry, useTirePressureOptimal } from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { TireGrid } from "../telemetry/TireGrid";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SectorDetailView } from "./SectorDetailView";
import { SectorMap } from "./SectorMap";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, type CornerKey, METRICS, type MetricKey } from "./SectorRangeBreakdown";
import { TrackFocusView } from "./track-focus/TrackFocusView";
import { Button } from "../ui/button";

interface TuneReviewDashboardProps {
  gameId: "acc" | "ac-evo";
  trackName?: string;
  laps: LapMeta[];
  /** When set, renders a "Back to session" button in the toolbar. */
  onBack?: () => void;
  /** The version node being reviewed (resolved by the route from ?versionId or
   *  the session HEAD). Used to display its driver comment / engineer notes
   *  read-only — editing stays in VersionGraph. */
  test?: ExperimentVersion;
  /** The experiment being reviewed (from the route param). Drives the
   *  Track Focus line-spread lane + map heat. Passed straight through rather
   *  than read off `test` so it survives an orphaned/missing test row. */
  experimentId?: number | null;
  /** Fires whenever the compact text summary of the currently-open lap review
   *  changes (lap switch, sector telemetry load, metric change, etc.) — lets a
   *  parent pipe "what the user is currently looking at" into the Setup
   *  Engineer chat's request context. Fires with `null` when nothing is open
   *  (no laps yet). */
  onOpenLapContextChange?: (text: string | null) => void;
}

type SectorView = `s${number}`;
type ReviewView = "overview" | "track" | SectorView;
const SEVERITY_CLASS: Record<TuneIssue["severity"], string> = {
  critical: "text-status-danger border-status-danger/60 bg-status-danger/10",
  warn: "text-status-warning border-status-warning/60 bg-status-warning/10",
  info: "text-status-info border-status-info/60 bg-status-info/10",
};

/**
 * TuneReviewDashboard — post-lap analysis for a finished lap, in the "sector
 * spine" layout: the session's sectors are the organising columns (time + where on
 * track), then the lap's detected issues, tyre state, and the Setup Engineer
 * recommendation. Everything is reconstructed from the selected lap's stored
 * telemetry — no live stream.
 */
export function TuneReviewDashboard({ gameId, trackName, laps, onBack, test, experimentId, onOpenLapContextChange }: TuneReviewDashboardProps) {
  const validLaps = useMemo(() => [...laps].filter((l) => l.isValid).sort((a, b) => b.lapNumber - a.lapNumber), [laps]);

  // Focus lap lives in the URL (?lap=<id>) so it's linkable/shareable.
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { lap?: number; view?: ReviewView };
  const focusLap = validLaps.find((l) => l.id === search.lap) ?? validLaps[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setFocus = (id: number) => navigate({ search: (p: any) => ({ ...p, lap: id }) } as any);

  // Point the URL at a real lap when it's missing or stale for this session.
  // The track view is stint-wide: a missing ?lap= there means "All", so leave it.
  useEffect(() => {
    if (validLaps.length === 0) return;
    if (search.view === "track" && search.lap == null) return;
    if (validLaps.some((l) => l.id === search.lap)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ replace: true, search: (p: any) => ({ ...p, lap: validLaps[0].id }) } as any);
  }, [search.lap, validLaps, navigate]);

  const { data: lapTel, isLoading: loadingTel } = useLapTelemetry(focusLap?.id ?? null);
  const { data: issues } = useLapIssues(focusLap?.id ?? null);
  const pressureOptimal = useTirePressureOptimal(gameId, focusLap?.carOrdinal);

  const telemetry = lapTel?.telemetry ?? [];
  const sectorTimes = lapTel?.sectorTimes ?? null;
  const sectorCount = sectorTimes?.times.length ?? 3;
  const corners = useMemo(() => tireSnapshot(telemetry), [telemetry]);
  const game = tryGetGame(gameId);

  const [metricKey, setMetricKey] = useState<MetricKey>("tyreTemp");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const ranges = useMemo(() => buildSectorRanges(telemetry, sectorTimes, metric), [telemetry, sectorTimes, metric]);

  // Bucket detected issues into sectors by their distance fraction. Issues with
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
  // Active view lives in the URL (?view=overview|s1..sN|track).
  const view = search.view ?? "overview";
  const requestedSector = /^s([1-9]\d*)$/.exec(view)?.[1];
  const parsedSectorIndex = requestedSector ? Number(requestedSector) - 1 : null;
  const sectorIndex = parsedSectorIndex != null && parsedSectorIndex < sectorCount ? parsedSectorIndex : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setView = (v: ReviewView) =>
    // Entering the track view defaults the lap picker to "All" (no ?lap=).
    navigate({ search: (p: any) => ({ ...p, view: v === "overview" ? undefined : v, lap: v === "track" ? undefined : (p.lap ?? focusLap?.id) }) } as any);
  // In the track view, no ?lap= means "All laps"; a stale id also counts as All.
  const trackFocusId = view === "track" && validLaps.some((l) => l.id === search.lap) ? (search.lap as number) : null;
  const cursor = useMemo(() => {
    if (!hoverPos) return undefined;
    const f = telemetry[hoverPos.idx];
    if (!f) return undefined;
    const out: Partial<Record<CornerKey, number>> = {};
    for (const c of CORNERS) {
      const v = metric.sel[c](f);
      if (v != null && Number.isFinite(v)) out[c] = v;
    }
    return out;
  }, [hoverPos, telemetry, metric]);

  // Hover readout for the map: the selected metric's four corner values at the
  // cursor's point on the lap.
  const readout = useCallback(
    (frame: TelemetryPacket) =>
      CORNERS.map((c) => {
        const v = metric.sel[c](frame);
        const ok = v != null && Number.isFinite(v);
        return {
          label: c,
          value: ok ? `${v!.toFixed(metric.key === "wear" ? 0 : 1)} ${metric.unit}` : "—",
          color: !ok ? undefined : metric.semantic ? bandColor(v!) : metric.accent,
        };
      }),
    [metric],
  );

  // Compact text summary of exactly what's rendered for the focused lap —
  // lap/time, sector times + deltas vs this session's best, corner/tyre data,
  // detected issues, the selected metric's per-sector ranges, driver/engineer
  // notes, and excluded/invalid flags. Piped up to the parent so it can feed
  // the Setup Engineer chat "what the user currently sees" (rebuilt whenever
  // any of this changes, not captured once).
  const openLapContext = useMemo(() => {
    if (!focusLap) return null;
    const lines: string[] = [];
    lines.push("CURRENTLY OPEN LAP REVIEW (visible to user):");
    lines.push(
      `Lap ${focusLap.lapNumber} — ${focusLap.lapTime.toFixed(3)}s${focusLap.isValid ? "" : ` (INVALID${focusLap.invalidReason ? `: ${focusLap.invalidReason}` : ""})`}${focusLap.experimentExcluded ? " (excluded from tuning aggregate)" : ""}`,
    );

    if (sectorTimes) {
      const bestOf = (sectorIndex: number) => {
        let best: number | undefined;
        for (const l of laps) {
          const v = l.sectorTimes?.[sectorIndex];
          if (v == null || v <= 0) continue;
          if (best == null || v < best) best = v;
        }
        return best;
      };
      const bestS = sectorTimes.times.map((_, index) => bestOf(index));
      const sectorLine = sectorTimes.times
        .map((time, index) => {
          if (!(time > 0)) return `S${index + 1} —`;
          const best = bestS[index];
          const delta = best != null ? time - best : null;
          const deltaStr = delta == null ? "" : delta <= 0.0005 ? " (best)" : ` (+${delta.toFixed(3)})`;
          return `S${index + 1} ${time.toFixed(3)}s${deltaStr}`;
        })
        .join(", ");
      lines.push(`Sectors: ${sectorLine}`);
    }

    if (corners) {
      const cornerLine = CORNERS.map((c) => {
        const s = corners[c];
        return `${c} temp ${s.tempC.toFixed(0)}°C, wear ${s.wear.toFixed(0)}%, pressure ${s.pressure.toFixed(1)}psi, brake ${s.brakeTemp.toFixed(0)}°C`;
      }).join("; ");
      lines.push(`Tyres (end of lap): ${cornerLine}`);
    }

    if (issues && issues.length > 0) {
      lines.push(`Detected issues: ${issues.map((it) => `${it.kind}${it.corner ? ` ${it.corner}` : ""} (${it.severity}) — ${it.detail}`).join("; ")}`);
    } else if (issues) {
      lines.push("Detected issues: none.");
    }

    if (ranges) {
      lines.push(`${metric.label} ranges (min-max, ${metric.unit}) by sector:`);
      ranges.sectors.forEach((sec, i) => {
        const cornerStr = CORNERS.map((c) => {
          const r = sec[c];
          return r.n === 0 ? `${c} —` : `${c} ${r.min.toFixed(0)}-${r.max.toFixed(0)} (avg ${r.avg.toFixed(0)})`;
        }).join(", ");
        lines.push(`  S${i + 1}: ${cornerStr}`);
      });
    }

    if (test?.driverComment) lines.push(`Driver comment: ${test.driverComment}`);
    if (test?.notes) lines.push(`Engineer notes: ${test.notes}`);

    return lines.join("\n");
  }, [focusLap, sectorTimes, laps, corners, issues, ranges, metric, test]);

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
            <Button type="button" variant="app-outline" size="app-sm" onClick={onBack}>
              ← Session
            </Button>
          )}
          <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Post-lap</span>
          <select
            className="bg-app-surface-alt border border-app-border rounded px-2 py-1 text-app-detail font-mono"
            value={view === "track" ? (trackFocusId ?? "all") : focusLap.id}
            onChange={(e) => {
              if (e.target.value === "all") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                navigate({ search: (p: any) => ({ ...p, lap: undefined }) } as any);
              } else {
                setFocus(Number(e.target.value));
              }
            }}
          >
            {view === "track" && <option value="all">All laps</option>}
            {validLaps.map((l) => (
              <option key={l.id} value={l.id}>
                Lap {l.lapNumber} — {l.lapTime.toFixed(3)}s
              </option>
            ))}
          </select>
          {!(view === "track" && trackFocusId == null) && (
            <span className="text-status-success text-sm" title="valid lap">
              ✓
            </span>
          )}
          <div className="flex gap-1">
            {(["overview", ...Array.from({ length: sectorCount }, (_, index) => `s${index + 1}` as SectorView), "track"] as ReviewView[]).map((v) => (
              <Button
                key={v}
                type="button"
                variant="app-outline"
                size="app-sm"
                onClick={() => setView(v)}
                className={view === v ? "text-app-accent bg-app-accent/10" : "text-app-text-muted"}
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
                    type="button"
                    variant="app-outline"
                    size="app-sm"
                    onClick={() => setMetricKey(m.key)}
                    className={m.key === metricKey ? "text-app-accent bg-app-accent/10" : "text-app-text-muted"}
                  >
                    {m.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 @3xl/workspace:auto-cols-fr @3xl/workspace:grid-flow-col">
              {Array.from({ length: sectorCount }, (_, i) => `S${i + 1}`).map((label, i) => (
                <div key={label} className={`border-t border-app-border p-3 first:border-t-0 @3xl/workspace:border-t-0 ${i < sectorCount - 1 ? "border-app-border @3xl/workspace:border-r" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
                    <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sector {i + 1}</span>
                  </div>
                  <div className="text-xl font-mono tabular-nums text-app-text mt-1.5">{sectorTimes && sectorTimes.times[i] > 0 ? sectorTimes.times[i].toFixed(3) : "—"}</div>
                  {telemetry.length > 0 ? (
                    <SectorMap
                      telemetry={telemetry}
                      sectorTimes={sectorTimes}
                      highlight={i}
                      showTimes={false}
                      trackOrdinal={focusLap.trackOrdinal}
                      readout={readout}
                      onHover={(idx) => setHoverPos(idx == null ? null : { sector: i, idx })}
                      markFraction={markedIssue?.sector === i ? markedIssue.frac : null}
                    />
                  ) : (
                    <div className="p-4 text-xs text-app-text-dim">{loadingTel ? "Loading…" : "No telemetry"}</div>
                  )}
                  {/* Per-sector metric range under this sector's map */}
                  {ranges && (
                    <div className="mt-1">
                      <CornerBars ranges={ranges.sectors[i]} domain={ranges.domain} metric={metric} cursor={hoverPos?.sector === i ? cursor : undefined} />
                    </div>
                  )}
                </div>
              ))}
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
          <TrackFocusView gameId={gameId} laps={laps} trackOrdinal={focusLap.trackOrdinal} focusLapId={trackFocusId} onFocusLap={setFocus} experimentId={experimentId ?? test?.experimentId ?? null} />
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

/** Overview skeleton shown when the session has no recorded lap yet — mirrors
 *  the real overview (toolbar + sector spine) with placeholder times/maps so the
 *  page reads as the review dashboard, not a bare empty message. */
/**
 * The headline read for THIS arm, judged on its own terms.
 *
 * A setup arm is meant to move outright pace, so best lap leads. A drill is
 * meant to make the driver repeatable — its win condition can be a tighter
 * spread at an unchanged best lap, which a best-lap headline scores as "no
 * change". Both numbers stay on screen either way; only which one leads
 * changes, so nothing is hidden from a driver who wants the other read.
 */
function ArmHeadline({ kind, laps }: { kind: VersionKind; laps: LapMeta[] }) {
  const times = laps.map((l) => l.lapTime).filter((t) => t > 0);
  const best = times.length ? Math.min(...times) : null;
  // Spread, not standard deviation: with the 3–8 laps a stint actually
  // produces, "my worst lap was 0.4s off my best" is a number a driver can act
  // on, and σ over that few samples is noise wearing a statistic's clothes.
  const spread = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
  const metric = headlineMetricForVersionKind(kind);

  const lead = metric === "consistency" ? { label: "Lap-time spread", value: spread != null ? `${spread.toFixed(3)}s` : "—" } : { label: "Best lap", value: best != null ? formatLapTime(best) : "—" };
  const secondary = metric === "consistency" ? { label: "Best lap", value: best != null ? formatLapTime(best) : "—" } : { label: "Spread", value: spread != null ? `${spread.toFixed(3)}s` : "—" };

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-app-border px-4 py-2.5">
      <span
        className="review-kind-badge rounded-full px-2 py-0.5 text-app-caption font-medium"
        data-review-kind={kind}
        title={kind === "drill" ? "A driving drill — judged on consistency" : "A setup version — judged on best lap"}
      >
        {kind === "drill" ? "Driving drill" : "Setup version"}
      </span>
      <div>
        <div className="text-app-caption uppercase tracking-wider text-app-text-muted">{lead.label}</div>
        <div className="font-mono text-sm text-app-text tabular-nums">{lead.value}</div>
      </div>
      <div>
        <div className="text-app-caption uppercase tracking-wider text-app-text-muted">{secondary.label}</div>
        <div className="font-mono text-sm text-app-text-dim tabular-nums">{secondary.value}</div>
      </div>
      <div>
        <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Valid laps</div>
        <div className="font-mono text-sm text-app-text-dim tabular-nums">{times.length}</div>
      </div>
    </div>
  );
}

function ReviewOverviewSkeleton({ trackName, onBack }: { trackName?: string; onBack?: () => void }) {
  return (
    <div>
      {/* Toolbar — mirrors the real one; controls disabled with no lap loaded. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
        {onBack && (
          <Button type="button" variant="app-outline" size="app-sm" onClick={onBack}>
            ← Session
          </Button>
        )}
        <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Post-lap</span>
        <div className="bg-app-surface-alt border border-app-border rounded px-2 py-1 text-sm font-mono text-app-text-dim">No laps yet</div>
        <div className="flex gap-1">
          {(["overview", "s1", "s2", "s3", "track"] as const).map((v) => (
            <span key={v} className={`px-2.5 py-1 text-xs rounded border ${v === "overview" ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-dim"}`}>
              {v === "overview" ? "Overview" : v === "track" ? "Track" : `Sector ${v.slice(1)}`}
            </span>
          ))}
        </div>
        {trackName && <span className="ml-auto hidden text-xs text-app-text-muted @5xl/workspace:inline">{trackName}</span>}
      </div>

      {/* Sector spine — placeholder times + empty maps. */}
      <div className="border-b border-app-border">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-app-border">
          <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sectors</span>
        </div>
        <div className="grid grid-cols-1 @3xl/workspace:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`border-t border-app-border p-3 first:border-t-0 @3xl/workspace:border-t-0 ${i < 2 ? "border-app-border @3xl/workspace:border-r" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLOR_VARS[i] }} />
                <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sector {i + 1}</span>
              </div>
              <div className="text-xl font-mono tabular-nums text-app-text-dim mt-1.5">—</div>
              <div className="mt-2 aspect-video rounded border border-dashed border-app-border grid place-items-center text-xs text-app-text-dim">No telemetry</div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 py-6 text-sm text-app-text-dim">Drive a stint and finish a lap — your recorded laps and their sector breakdown will appear here.</div>
    </div>
  );
}

function IssuePill({ issue, onHover }: { issue: TuneIssue; onHover?: (frac: number | null) => void }) {
  const locatable = issue.distanceFrac != null && !!onHover;
  if (!locatable) {
    return (
      <div className={`text-xs px-2 py-1 rounded border ${SEVERITY_CLASS[issue.severity]}`}>
        <span className="font-mono uppercase mr-1.5 opacity-70">{issue.kind}</span>
        {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
        {issue.detail}
      </div>
    );
  }
  return (
    <button
      type="button"
      onMouseEnter={() => onHover!(issue.distanceFrac!)}
      onMouseLeave={() => onHover!(null)}
      onFocus={() => onHover!(issue.distanceFrac!)}
      onBlur={() => onHover!(null)}
      className={`text-xs px-2 py-1 rounded border text-left ${SEVERITY_CLASS[issue.severity]} cursor-pointer`}
    >
      <span className="font-mono uppercase mr-1.5 opacity-70">{issue.kind}</span>
      {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
      {issue.detail}
    </button>
  );
}

export interface CornerSnap {
  tempC: number;
  wear: number;
  pressure: number;
  brakeTemp: number;
}

/** End-of-lap tyre snapshot: averaged temp/pressure/brake-temp, wear at end. */
export function tireSnapshot(pkts: TelemetryPacket[]): Record<"FL" | "FR" | "RL" | "RR", CornerSnap> | null {
  if (pkts.length === 0) return null;
  const last = pkts[pkts.length - 1];
  const avg = (sel: (p: TelemetryPacket) => number | undefined) => {
    let s = 0;
    for (const p of pkts) s += sel(p) ?? 0;
    return s / pkts.length;
  };
  return {
    FL: { tempC: avg((p) => p.TireTempFL), wear: last.TireWearFL, pressure: avg((p) => p.TirePressureFrontLeft), brakeTemp: avg((p) => p.BrakeTempFrontLeft) },
    FR: { tempC: avg((p) => p.TireTempFR), wear: last.TireWearFR, pressure: avg((p) => p.TirePressureFrontRight), brakeTemp: avg((p) => p.BrakeTempFrontRight) },
    RL: { tempC: avg((p) => p.TireTempRL), wear: last.TireWearRL, pressure: avg((p) => p.TirePressureRearLeft), brakeTemp: avg((p) => p.BrakeTempRearLeft) },
    RR: { tempC: avg((p) => p.TireTempRR), wear: last.TireWearRR, pressure: avg((p) => p.TirePressureRearRight), brakeTemp: avg((p) => p.BrakeTempRearRight) },
  };
}
