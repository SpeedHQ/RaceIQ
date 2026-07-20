import { tryGetGame } from "@shared/games/registry";
import type { LapMeta, TelemetryPacket, TuneIssue } from "@shared/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TuningTest } from "../../hooks/queries";
import { useLapIssues, useLapTelemetry, useTirePressureOptimal } from "../../hooks/queries";
import { TireGrid } from "../telemetry/TireGrid";
import { SectorDetailView } from "./SectorDetailView";
import { SectorMap } from "./SectorMap";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, type CornerKey, METRICS, type MetricKey } from "./SectorRangeBreakdown";
import { NoSetupsHint, SetupEngineerControls, SetupEngineerResult, useSetupEngineer } from "./SetupEngineer";

interface TuneReviewDashboardProps {
  gameId: "acc" | "ac-evo";
  trackName?: string;
  laps: LapMeta[];
  /** When set, renders a "Back to session" button in the toolbar. */
  onBack?: () => void;
  /** The version node being reviewed (resolved by the route from ?testId or
   *  the session HEAD). Used to display its driver comment / engineer notes
   *  read-only — editing stays in VersionGraph. */
  test?: TuningTest;
  /** Fires whenever the compact text summary of the currently-open lap review
   *  changes (lap switch, sector telemetry load, metric change, etc.) — lets a
   *  parent pipe "what the user is currently looking at" into the Setup
   *  Engineer chat's request context. Fires with `null` when nothing is open
   *  (no laps yet). */
  onOpenLapContextChange?: (text: string | null) => void;
}

const SECTOR_COLORS = ["#f87171", "#60a5fa", "#facc15"] as const;
const SEVERITY_CLASS: Record<TuneIssue["severity"], string> = {
  critical: "text-red-400 border-red-800/60 bg-red-950/30",
  warn: "text-amber-400 border-amber-800/60 bg-amber-950/30",
  info: "text-sky-400 border-sky-800/60 bg-sky-950/30",
};

/**
 * TuneReviewDashboard — post-lap analysis for a finished lap, in the "sector
 * spine" layout: the three sectors are the organising columns (time + where on
 * track), then the lap's detected issues, tyre state, and the Setup Engineer
 * recommendation. Everything is reconstructed from the selected lap's stored
 * telemetry — no live stream.
 */
export function TuneReviewDashboard({ gameId, trackName, laps, onBack, test, onOpenLapContextChange }: TuneReviewDashboardProps) {
  const validLaps = useMemo(() => [...laps].filter((l) => l.isValid && !l.isLegacy).sort((a, b) => b.lapNumber - a.lapNumber), [laps]);

  // Focus lap lives in the URL (?lap=<id>) so it's linkable/shareable.
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { lap?: number; view?: "overview" | "s1" | "s2" | "s3" };
  const focusLap = validLaps.find((l) => l.id === search.lap) ?? validLaps[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setFocus = (id: number) => navigate({ search: (p: any) => ({ ...p, lap: id }) } as any);

  // Point the URL at a real lap when it's missing or stale for this session.
  useEffect(() => {
    if (validLaps.length === 0) return;
    if (validLaps.some((l) => l.id === search.lap)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ replace: true, search: (p: any) => ({ ...p, lap: validLaps[0].id }) } as any);
  }, [search.lap, validLaps, navigate]);

  const { data: lapTel, isLoading: loadingTel } = useLapTelemetry(focusLap?.id ?? null);
  const { data: issues } = useLapIssues(focusLap?.id ?? null);
  const pressureOptimal = useTirePressureOptimal(gameId, focusLap?.carOrdinal);
  const engineer = useSetupEngineer(gameId, trackName);

  const telemetry = lapTel?.telemetry ?? [];
  const sectorTimes = lapTel?.sectorTimes ?? null;
  const corners = useMemo(() => tireSnapshot(telemetry), [telemetry]);
  const game = tryGetGame(gameId);

  const [metricKey, setMetricKey] = useState<MetricKey>("tyreTemp");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const ranges = useMemo(() => buildSectorRanges(telemetry, sectorTimes, metric), [telemetry, sectorTimes, metric]);

  // Bucket detected issues into sectors by their distance fraction. Issues with
  // no position (lap-wide, e.g. average tyre pressure) go to the whole-lap strip.
  const issueGroups = useMemo(() => {
    const bySector: TuneIssue[][] = [[], [], []];
    const wholeLap: TuneIssue[] = [];
    const len = telemetry.length;
    const s1f = sectorTimes && len > 1 ? sectorTimes.s1Idx / (len - 1) : 1 / 3;
    const s2f = sectorTimes && len > 1 ? sectorTimes.s2Idx / (len - 1) : 2 / 3;
    for (const it of issues ?? []) {
      if (it.distanceFrac == null) {
        wholeLap.push(it);
        continue;
      }
      const s = it.distanceFrac < s1f ? 0 : it.distanceFrac < s2f ? 1 : 2;
      bySector[s].push(it);
    }
    return { bySector, wholeLap };
  }, [issues, telemetry.length, sectorTimes]);

  // Hover position: which sector column is being scrubbed, and the frame index.
  // Only the hovered sector's bars show the cursor line.
  const [hoverPos, setHoverPos] = useState<{ sector: number; idx: number } | null>(null);
  // An issue's location, marked on its sector map while its list item is hovered.
  const [markedIssue, setMarkedIssue] = useState<{ sector: number; frac: number } | null>(null);
  // Active view lives in the URL (?view=overview|s1|s2|s3).
  const view = search.view ?? "overview";
  const sectorIndex = view === "s1" ? 0 : view === "s2" ? 1 : view === "s3" ? 2 : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setView = (v: "overview" | "s1" | "s2" | "s3") => navigate({ search: (p: any) => ({ ...p, view: v === "overview" ? undefined : v }) } as any);
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
      `Lap ${focusLap.lapNumber} — ${focusLap.lapTime.toFixed(3)}s${focusLap.isValid ? "" : ` (INVALID${focusLap.invalidReason ? `: ${focusLap.invalidReason}` : ""})`}${focusLap.tuningExcluded ? " (excluded from tuning aggregate)" : ""}`,
    );

    if (sectorTimes) {
      const bestOf = (sel: (l: LapMeta) => number | undefined) => {
        let best: number | undefined;
        for (const l of laps) {
          const v = sel(l);
          if (v == null || v <= 0) continue;
          if (best == null || v < best) best = v;
        }
        return best;
      };
      const bestS = [bestOf((l) => l.s1Time), bestOf((l) => l.s2Time), bestOf((l) => l.s3Time)];
      const sectorLine = [0, 1, 2]
        .map((i) => {
          const t = sectorTimes.times[i];
          if (!(t > 0)) return `S${i + 1} —`;
          const best = bestS[i];
          const delta = best != null ? t - best : null;
          const deltaStr = delta == null ? "" : delta <= 0.0005 ? " (best)" : ` (+${delta.toFixed(3)})`;
          return `S${i + 1} ${t.toFixed(3)}s${deltaStr}`;
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

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Toolbar: lap picker + view switcher on the left, Setup Engineer on the right */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
        {onBack && (
          <button type="button" onClick={onBack} className="px-2.5 py-1 text-xs rounded border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-dim">
            ← Session
          </button>
        )}
        <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Post-lap</span>
        <select className="bg-app-panel border border-app-border rounded px-2 py-1 text-sm font-mono" value={focusLap.id} onChange={(e) => setFocus(Number(e.target.value))}>
          {validLaps.map((l) => (
            <option key={l.id} value={l.id}>
              Lap {l.lapNumber} — {l.lapTime.toFixed(3)}s
            </option>
          ))}
        </select>
        <span className="text-emerald-400 text-sm" title="valid lap">
          ✓
        </span>
        <div className="flex gap-1">
          {(["overview", "s1", "s2", "s3"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-2.5 py-1 text-xs rounded border ${view === v ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
            >
              {v === "overview" ? "Overview" : `Sector ${v.slice(1)}`}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {trackName && <span className="hidden lg:inline text-xs text-app-text-muted">{trackName}</span>}
          <SetupEngineerControls state={engineer} lapId={focusLap.id} />
        </div>
      </div>

      {(test?.driverComment || test?.notes) && (
        <div className="border-b border-app-border px-4 py-2.5 space-y-2">
          {test?.driverComment && (
            <div>
              <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Driver comment</div>
              <div className="text-xs text-app-text whitespace-pre-wrap">{test.driverComment}</div>
            </div>
          )}
          {test?.notes && (
            <div>
              <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Engineer notes</div>
              <div className="text-xs text-app-text whitespace-pre-wrap">{test.notes}</div>
            </div>
          )}
        </div>
      )}

      {sectorIndex != null ? (
        <SectorDetailView telemetry={telemetry} sectorTimes={sectorTimes} sectorIndex={sectorIndex} trackOrdinal={focusLap.trackOrdinal} issues={issueGroups.bySector[sectorIndex]} />
      ) : (
        <>
          {/* Sector spine */}
          <div className="border-b border-app-border">
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-app-border">
              <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Sectors</span>
              <div className="flex gap-1 flex-wrap justify-end">
                {METRICS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMetricKey(m.key)}
                    className={`px-2 py-0.5 text-[11px] rounded border ${
                      m.key === metricKey ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className={`p-3 ${i < 2 ? "sm:border-r border-app-border" : ""} border-t sm:border-t-0 border-app-border first:border-t-0`}>
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLORS[i] }} />
                    <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Sector {i + 1}</span>
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
              <div className="px-4 py-1.5 text-[11px] text-app-text-dim border-t border-app-border">
                {metric.label}: bars span min→max, tick = average · shared scale {Math.round(ranges.domain[0])}–{Math.round(ranges.domain[1])} {metric.unit}
              </div>
            )}
          </div>

          {/* Detected issues, laid out per sector */}
          <div className="border-b border-app-border">
            <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Detected from telemetry</div>
            {!issues ? (
              <div className="px-4 pb-3 text-xs text-app-text-dim">Loading issues…</div>
            ) : issues.length === 0 ? (
              <div className="px-4 pb-3 text-xs text-app-text-dim">No handling or tyre issues detected on this lap.</div>
            ) : (
              <>
                {issueGroups.wholeLap.length > 0 && (
                  <div className="px-4 pb-2">
                    <div className="text-[10px] text-app-text-dim uppercase tracking-wider mb-1">Whole lap</div>
                    <div className="flex flex-wrap gap-2">
                      {issueGroups.wholeLap.map((it) => (
                        <IssuePill key={`${it.kind}-${it.corner ?? ""}-${it.detail}`} issue={it} />
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className={`px-3 py-2 ${i < 2 ? "sm:border-r border-app-border" : ""} border-t sm:border-t-0 border-app-border`}>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="w-3 h-1 rounded" style={{ background: SECTOR_COLORS[i] }} />
                        <span className="text-[10px] text-app-text-muted uppercase tracking-wider">Sector {i + 1}</span>
                      </div>
                      {issueGroups.bySector[i].length === 0 ? (
                        <div className="text-[11px] text-app-text-dim">No issues</div>
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

          {/* Tyres + recommendation */}
          <div className="grid grid-cols-1 lg:grid-cols-2">
            <div className="lg:border-r border-app-border">
              <div className="px-3 pt-3 text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Tyres · end of lap</div>
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
            <div>
              <div className="px-3 pt-3 text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Setup Engineer</div>
              <div className="px-3 pt-2">
                <NoSetupsHint state={engineer} />
              </div>
              <SetupEngineerResult state={engineer} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Overview skeleton shown when the session has no recorded lap yet — mirrors
 *  the real overview (toolbar + sector spine) with placeholder times/maps so the
 *  page reads as the review dashboard, not a bare empty message. */
function ReviewOverviewSkeleton({ trackName, onBack }: { trackName?: string; onBack?: () => void }) {
  return (
    <div className="flex-1 overflow-y-auto">
      {/* Toolbar — mirrors the real one; controls disabled with no lap loaded. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
        {onBack && (
          <button type="button" onClick={onBack} className="px-2.5 py-1 text-xs rounded border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-dim">
            ← Session
          </button>
        )}
        <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Post-lap</span>
        <div className="bg-app-panel border border-app-border rounded px-2 py-1 text-sm font-mono text-app-text-dim">No laps yet</div>
        <div className="flex gap-1">
          {(["overview", "s1", "s2", "s3"] as const).map((v) => (
            <span key={v} className={`px-2.5 py-1 text-xs rounded border ${v === "overview" ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-dim"}`}>
              {v === "overview" ? "Overview" : `Sector ${v.slice(1)}`}
            </span>
          ))}
        </div>
        {trackName && <span className="ml-auto hidden lg:inline text-xs text-app-text-muted">{trackName}</span>}
      </div>

      {/* Sector spine — placeholder times + empty maps. */}
      <div className="border-b border-app-border">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-app-border">
          <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Sectors</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`p-3 ${i < 2 ? "sm:border-r border-app-border" : ""} border-t sm:border-t-0 border-app-border first:border-t-0`}>
              <div className="flex items-center gap-2">
                <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLORS[i] }} />
                <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Sector {i + 1}</span>
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
