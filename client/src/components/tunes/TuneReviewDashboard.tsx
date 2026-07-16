import { tryGetGame } from "@shared/games/registry";
import type { LapMeta, TelemetryPacket, TuneIssue } from "@shared/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLapIssues, useLapTelemetry, useTirePressureOptimal } from "../../hooks/queries";
import { TireGrid } from "../telemetry/TireGrid";
import { SectorDetailView } from "./SectorDetailView";
import { SectorMap } from "./SectorMap";
import { CORNERS, CornerBars, type CornerKey, METRICS, type MetricKey, bandColor, buildSectorRanges } from "./SectorRangeBreakdown";
import { NoSetupsHint, SetupEngineerControls, SetupEngineerResult, useSetupEngineer } from "./SetupEngineer";

interface TuneReviewDashboardProps {
  gameId: "acc" | "ac-evo";
  trackName?: string;
  laps: LapMeta[];
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
export function TuneReviewDashboard({ gameId, trackName, laps }: TuneReviewDashboardProps) {
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
  const snap = useMemo(() => tireSnapshot(telemetry), [telemetry]);
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

  if (!focusLap) {
    return <div className="p-6 text-sm text-app-text-dim">No valid laps with telemetry in this session yet.</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Toolbar: lap picker + view switcher on the left, Setup Engineer on the right */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
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
                {snap ? (
                  <TireGrid
                    fl={{ tempC: snap.FL.tempC, wear: snap.FL.wear, brakeTemp: snap.FL.brakeTemp, pressure: snap.FL.pressure }}
                    fr={{ tempC: snap.FR.tempC, wear: snap.FR.wear, brakeTemp: snap.FR.brakeTemp, pressure: snap.FR.pressure }}
                    rl={{ tempC: snap.RL.tempC, wear: snap.RL.wear, brakeTemp: snap.RL.brakeTemp, pressure: snap.RL.pressure }}
                    rr={{ tempC: snap.RR.tempC, wear: snap.RR.wear, brakeTemp: snap.RR.brakeTemp, pressure: snap.RR.pressure }}
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

function IssuePill({ issue, onHover }: { issue: TuneIssue; onHover?: (frac: number | null) => void }) {
  const locatable = issue.distanceFrac != null && !!onHover;
  return (
    <div
      onMouseEnter={locatable ? () => onHover!(issue.distanceFrac!) : undefined}
      onMouseLeave={locatable ? () => onHover!(null) : undefined}
      className={`text-xs px-2 py-1 rounded border ${SEVERITY_CLASS[issue.severity]} ${locatable ? "cursor-pointer" : ""}`}
    >
      <span className="font-mono uppercase mr-1.5 opacity-70">{issue.kind}</span>
      {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
      {issue.detail}
    </div>
  );
}

interface CornerSnap {
  tempC: number;
  wear: number;
  pressure: number;
  brakeTemp: number;
}

/** End-of-lap tyre snapshot: averaged temp/pressure/brake-temp, wear at end. */
function tireSnapshot(pkts: TelemetryPacket[]): Record<"FL" | "FR" | "RL" | "RR", CornerSnap> | null {
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
