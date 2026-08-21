import { isTimedLapEligibilityUsable } from "@shared/racing/quality/policies";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { rangeBandGradient } from "./helpers";
import type { TrackLap } from "./types";

type LapFilter = null | "race" | "quali";

function LapStatsHeader({ hasRaceFilter, lapFilter, onFilterChange }: { hasRaceFilter: boolean; lapFilter: LapFilter; onFilterChange: (filter: Exclude<LapFilter, null>) => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between rounded-none border-b border-app-border bg-app-surface p-3 py-2">
      <div className="flex items-center gap-2">
        <div className="text-app-label text-app-text-muted uppercase tracking-wider">{m.track_detail_stats()}</div>
        {hasRaceFilter && (
          <div className="flex rounded overflow-hidden border border-app-border text-xs">
            {(["race", "quali"] as const).map((filter) => (
              <Button
                type="button"
                key={filter}
                onClick={() => onFilterChange(filter)}
                className={`px-2 py-1 transition-colors capitalize ${
                  lapFilter === filter
                    ? filter === "race"
                      ? "bg-status-success/15 text-status-success border-r border-app-border"
                      : "bg-status-warning/15 text-status-warning"
                    : `text-app-text-dim hover:text-app-text-secondary${filter === "race" ? " border-r border-app-border" : ""}`
                }`}
              >
                {filter === "race" ? m.track_detail_race() : m.track_detail_quali()}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="text-app-compact text-app-text-dim font-mono">{m.track_detail_last_100()}</div>
    </div>
  );
}

function EmptyLapStats({ message }: { message: string }) {
  return (
    <div className="flex-1 p-3 flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[
          { key: "best", label: m.label_best() },
          { key: "median", label: m.track_detail_median() },
          { key: "worst", label: m.track_detail_worst() },
        ].map(({ key, label }) => (
          <div key={key} className="flex items-baseline gap-1.5">
            <div className="text-xs text-app-text-dim uppercase tracking-wider">{label}</div>
            <div className="font-mono text-app-body tabular-nums text-app-text-dim">—:—.—</div>
          </div>
        ))}
      </div>
      <div className="relative h-2 bg-app-surface-alt rounded-full overflow-visible" />
      <div className="text-app-subtext text-app-text-dim py-4 text-center">{message}</div>
    </div>
  );
}

export function LapStatsPanel({ laps, sectorCount, showSessionFilter }: { laps: TrackLap[]; sectorCount: number; showSessionFilter?: boolean }) {
  const [lapFilter, setLapFilter] = useState<LapFilter>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  if (laps.length === 0) {
    return (
      <div className="w-full min-w-0 @3xl/workspace:w-2/5">
        <LapStatsHeader hasRaceFilter={false} lapFilter={lapFilter} onFilterChange={() => undefined} />
        <EmptyLapStats message={m.track_detail_no_laps_recorded()} />
      </div>
    );
  }
  const sessionCounts = new Map<number, number>();
  if (showSessionFilter) {
    for (const l of laps) {
      if (l.sessionId != null) sessionCounts.set(l.sessionId, (sessionCounts.get(l.sessionId) ?? 0) + 1);
    }
  }
  const hasRaceFilter = showSessionFilter && [...sessionCounts.values()].some((c) => c > 1);
  const filteredLaps =
    showSessionFilter && lapFilter === "race"
      ? laps.filter((l) => l.sessionId != null && (sessionCounts.get(l.sessionId) ?? 0) > 1)
      : showSessionFilter && lapFilter === "quali"
        ? laps.filter((l) => l.sessionId == null || (sessionCounts.get(l.sessionId) ?? 0) === 1)
        : laps;
  // All stats use most recent 100 pace-eligible laps.
  const chronoLaps = [...filteredLaps.filter((lap) => isTimedLapEligibilityUsable(lap))].sort((a, b) => a.lapId - b.lapId).slice(-100);
  if (chronoLaps.length === 0) {
    return (
      <div className="w-full min-w-0 @3xl/workspace:w-2/5">
        <LapStatsHeader hasRaceFilter={Boolean(hasRaceFilter)} lapFilter={lapFilter} onFilterChange={(filter) => setLapFilter(lapFilter === filter ? null : filter)} />
        <EmptyLapStats message={m.track_detail_no_eligible_laps()} />
      </div>
    );
  }
  const times = [...chronoLaps.map((l) => l.lapTime)].sort((a, b) => a - b);
  const minT = times[0];
  const maxT = times[times.length - 1];
  const mid = Math.floor(times.length / 2);
  const medT = times.length % 2 === 0 ? (times[mid - 1] + times[mid]) / 2 : times[mid];
  const range = maxT - minT || 1;
  const medPct = ((medT - minT) / range) * 100;
  const p25 = times[Math.floor((times.length - 1) * 0.25)];
  const p75 = times[Math.floor((times.length - 1) * 0.75)];
  const p25Pct = ((p25 - minT) / range) * 100;
  const p75Pct = ((p75 - minT) / range) * 100;
  // Trend direction: compare avg of first third vs last third
  const trendN = Math.max(1, Math.floor(chronoLaps.length / 3));
  const avgFirst = chronoLaps.slice(0, trendN).reduce((s, l) => s + l.lapTime, 0) / trendN;
  const avgLast = chronoLaps.slice(-trendN).reduce((s, l) => s + l.lapTime, 0) / trendN;
  const trendDelta = avgLast - avgFirst; // negative = getting faster
  const trendThreshold = avgFirst * 0.005; // 0.5% of avg lap time
  const trendDir = chronoLaps.length >= 4 ? (trendDelta < -trendThreshold ? "faster" : trendDelta > trendThreshold ? "slower" : "neutral") : "neutral";
  const trendStroke = trendDir === "faster" ? "var(--lap-pace-on-target)" : trendDir === "slower" ? "var(--lap-pace-off-target)" : "var(--app-text)";
  const vbW = 400;
  const vbH = 120;
  const padL = 4;
  const padR = 4;
  const padT = 16;
  const padB = 24;
  const plotW = vbW - padL - padR;
  const plotH = vbH - padT - padB;
  const sparkPoints = chronoLaps.map((l, i) => {
    const x = padL + (i / Math.max(chronoLaps.length - 1, 1)) * plotW;
    const y = padT + plotH - ((l.lapTime - minT) / range) * plotH;
    return { x, y, lapTime: l.lapTime };
  });
  const polyline = sparkPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const bestPoint = sparkPoints.reduce((b, p) => (p.y > b.y ? p : b), sparkPoints[0]);
  const worstPoint = sparkPoints.reduce((b, p) => (p.y < b.y ? p : b), sparkPoints[0]);
  // Linear regression trend line
  const n = sparkPoints.length;
  const sumX = sparkPoints.reduce((s, p) => s + p.x, 0);
  const sumY = sparkPoints.reduce((s, p) => s + p.y, 0);
  const sumXY = sparkPoints.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = sparkPoints.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX || 1;
  const trendM = (n * sumXY - sumX * sumY) / denom;
  const trendB = (sumY - trendM * sumX) / n;
  const trendX1 = sparkPoints[0].x;
  const trendX2 = sparkPoints[n - 1].x;
  const trendY1 = trendM * trendX1 + trendB;
  const trendY2 = trendM * trendX2 + trendB;
  const lastDate = chronoLaps[chronoLaps.length - 1]?.createdAt ? new Date(chronoLaps[chronoLaps.length - 1].createdAt!).toLocaleDateString([], { month: "short", day: "numeric" }) : "Recent";
  // Theoretical best sectors
  const lapsWithSectors = chronoLaps.filter((lap) => sectorCount >= 2 && lap.sectorTimes?.length === sectorCount && lap.sectorTimes.every((time) => time > 0));
  const hasSectors = lapsWithSectors.length > 0;
  const bestSectorTimes = hasSectors ? Array.from({ length: sectorCount }, (_, index) => Math.min(...lapsWithSectors.map((lap) => lap.sectorTimes![index]))) : [];
  const theoretical = hasSectors ? bestSectorTimes.reduce((sum, time) => sum + time, 0) : null;
  const sectorGap = theoretical != null ? minT - theoretical : null;
  // Sector range stats for mini range bars
  const sectorStats = hasSectors
    ? Array.from({ length: sectorCount }, (_, index) => {
        const vals = lapsWithSectors.map((lap) => lap.sectorTimes![index]).sort((a, b) => a - b);
        const mn = vals[0];
        const mx = vals[vals.length - 1];
        const rng = mx - mn || 1;
        const midI = Math.floor(vals.length / 2);
        const med = vals.length % 2 === 0 ? (vals[midI - 1] + vals[midI]) / 2 : vals[midI];
        const p25v = vals[Math.floor((vals.length - 1) * 0.25)];
        const p75v = vals[Math.floor((vals.length - 1) * 0.75)];
        return {
          label: `S${index + 1}`,
          min: mn,
          max: mx,
          med,
          range: mx - mn,
          medPct: ((med - mn) / rng) * 100,
          p25Pct: ((p25v - mn) / rng) * 100,
          p75Pct: ((p75v - mn) / rng) * 100,
        };
      })
    : null;
  // Per-car best times
  const carBests = new Map<number, { carOrdinal: number; carName: string; bestTime: number }>();
  for (const lap of chronoLaps) {
    const existing = carBests.get(lap.carOrdinal);
    if (!existing || lap.lapTime < existing.bestTime) {
      carBests.set(lap.carOrdinal, { carOrdinal: lap.carOrdinal, carName: lap.carName, bestTime: lap.lapTime });
    }
  }
  const carList = [...carBests.values()].sort((a, b) => a.bestTime - b.bestTime);
  const showCarBreakdown = carList.length > 1;
  const carWorst = carList.length > 0 ? carList[carList.length - 1].bestTime : minT;
  const carRange = carWorst - minT || 1;
  // By lap number: best time per lap number, top 10 by count
  const lapNumMap = new Map<number, { bestTime: number; count: number }>();
  for (const lap of chronoLaps) {
    const existing = lapNumMap.get(lap.lapNumber);
    if (!existing) {
      lapNumMap.set(lap.lapNumber, { bestTime: lap.lapTime, count: 1 });
    } else {
      existing.count++;
      if (lap.lapTime < existing.bestTime) existing.bestTime = lap.lapTime;
    }
  }
  const lapNumData = [...lapNumMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([lapNum, { bestTime, count }]) => ({ lapNum, bestTime, count }))
    .sort((a, b) => a.lapNum - b.lapNum);
  const lapNumWorst = lapNumData.length > 0 ? Math.max(...lapNumData.map((d) => d.bestTime)) : maxT;
  const lapNumBest = lapNumData.length > 0 ? Math.min(...lapNumData.map((d) => d.bestTime)) : minT;
  const lapNumRange = lapNumWorst - lapNumBest || 1;
  const showLapNumBreakdown = lapNumData.length > 1;

  return (
    <div className="w-full min-w-0 @3xl/workspace:w-2/5">
      <LapStatsHeader hasRaceFilter={Boolean(hasRaceFilter)} lapFilter={lapFilter} onFilterChange={(filter) => setLapFilter(lapFilter === filter ? null : filter)} />
      {/* Scrollable body */}
      <div className="flex flex-1 flex-col gap-3 p-3 @3xl/workspace:overflow-y-auto">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {[
            { key: "best", label: m.label_best(), value: minT, color: "var(--lap-record)" },
            { key: "median", label: m.track_detail_median(), value: medT, color: "var(--app-text)" },
            { key: "worst", label: m.track_detail_worst(), value: maxT, color: "var(--app-text)" },
          ].map(({ key, label, value, color }) => (
            <div key={key} className="flex items-baseline gap-1.5">
              <div className="text-xs text-app-text-dim uppercase tracking-wider">{label}</div>
              <div className="font-mono text-app-body tabular-nums" style={{ color }}>
                {formatLapTime(value)}
              </div>
            </div>
          ))}
        </div>
        {/* Range bar */}
        <div className="flex flex-col gap-1">
          <div className="relative h-2 bg-app-surface-alt rounded-full overflow-visible">
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: rangeBandGradient(p25Pct, p75Pct, 8, 25, 65),
              }}
            />
            <div className="absolute top-1/2 -translate-y-1/2 w-2 h-3 rounded-sm shadow" style={{ left: `calc(${medPct}% - 4px)`, background: "var(--app-text)", opacity: 0.8 }} />
          </div>
          <div className="flex justify-between items-center text-app-compact text-app-text-secondary font-mono">
            <span>{formatLapTime(minT)}</span>
            <span className="flex items-center gap-1 text-app-caption text-app-text-dim font-sans">
              <span className="inline-block w-2.5 h-1.5 rounded-sm" style={{ background: "var(--lap-pace-on-target)", opacity: 0.7 }} />
              {m.track_detail_typical_range()}
            </span>
            <span>{formatLapTime(maxT)}</span>
          </div>
        </div>
        {/* Lap time trend sparkline */}
        {chronoLaps.length >= 2 && (
          <div className="flex flex-col gap-0.5 border-t border-app-border pt-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="text-xs text-app-text-dim uppercase tracking-wider">{m.trackdetail_trend()}</div>
              {trendDir === "faster" && (
                <span className="text-xs font-medium" style={{ color: "var(--lap-pace-on-target)" }}>
                  ↓ {m.trackdetail_faster()}
                </span>
              )}
              {trendDir === "slower" && (
                <span className="text-xs font-medium" style={{ color: "var(--lap-pace-off-target)" }}>
                  ↑ {m.trackdetail_slower()}
                </span>
              )}
              {trendDir === "neutral" && chronoLaps.length >= 4 && <span className="text-xs text-app-text-secondary font-medium">→ {m.trackdetail_keeping_pace()}</span>}
            </div>
            <div className="relative">
              <svg
                width="100%"
                viewBox={`0 0 ${vbW} ${vbH}`}
                className="overflow-visible"
                onMouseLeave={() => setHoveredIdx(null)}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const svgX = ((e.clientX - rect.left) / rect.width) * vbW;
                  let closest = 0;
                  let minDist = Number.POSITIVE_INFINITY;
                  sparkPoints.forEach((p, i) => {
                    const d = Math.abs(p.x - svgX);
                    if (d < minDist) {
                      minDist = d;
                      closest = i;
                    }
                  });
                  setHoveredIdx(closest);
                }}
              >
                <defs>
                  <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={trendStroke} stopOpacity="0.15" />
                    <stop offset="100%" stopColor={trendStroke} stopOpacity="0" />
                  </linearGradient>
                </defs>
                {/* Grid lines */}
                <line x1={padL} y1={padT} x2={padL + plotW} y2={padT} stroke="var(--app-text)" strokeOpacity={0.06} strokeWidth="0.5" />
                <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="var(--app-text)" strokeOpacity={0.06} strokeWidth="0.5" />
                {/* Axis lines */}
                <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="var(--app-text)" strokeOpacity={0.08} strokeWidth="0.5" />
                <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="var(--app-text)" strokeOpacity={0.08} strokeWidth="0.5" />
                {/* Area fill */}
                <polygon points={`${polyline} ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)} ${padL},${(padT + plotH).toFixed(1)}`} fill="url(#areaFill)" />
                {/* Axis labels */}
                <text x={padL} y={vbH - 2} fontSize="8" fill="var(--app-text)" fillOpacity={0.3} fontFamily="var(--font-sans)">
                  {m.trackdetail_older()}
                </text>
                <text x={padL + plotW - 30} y={vbH - 2} fontSize="8" fill="var(--app-text)" fillOpacity={0.3} fontFamily="var(--font-sans)">
                  {lastDate}
                </text>
                {/* Trend line */}
                <line
                  x1={trendX1.toFixed(1)}
                  y1={trendY1.toFixed(1)}
                  x2={trendX2.toFixed(1)}
                  y2={trendY2.toFixed(1)}
                  stroke={trendStroke}
                  strokeOpacity={trendDir === "neutral" ? 0.2 : 0.6}
                  strokeWidth="1"
                  strokeDasharray="3 2"
                />
                {/* Sparkline */}
                <polyline points={polyline} fill="none" stroke="var(--lap-record)" strokeOpacity={0.5} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
                {/* Visible dots */}
                {sparkPoints.map((p, i) => (
                  <circle
                    key={`${p.x}-${p.y}`}
                    cx={p.x}
                    cy={p.y}
                    r={hoveredIdx === i ? 3 : 1.5}
                    fill={hoveredIdx === i ? "var(--app-text)" : "var(--lap-record)"}
                    fillOpacity={hoveredIdx === i ? 1 : 0.4}
                    style={{ pointerEvents: "none" }}
                  />
                ))}
                {/* Worst point */}
                <circle cx={worstPoint.x} cy={worstPoint.y} r="4" fill="var(--lap-pace-off-target)" fillOpacity={0.7} style={{ pointerEvents: "none" }} />
                <line x1={worstPoint.x} y1={worstPoint.y - 4} x2={worstPoint.x} y2={worstPoint.y - 14} stroke="var(--lap-pace-off-target)" strokeOpacity={0.5} strokeWidth="0.5" />
                <text
                  x={worstPoint.x > vbW / 2 ? worstPoint.x - 4 : worstPoint.x + 4}
                  y={worstPoint.y - 16}
                  fontSize="8"
                  fill="var(--lap-pace-off-target)"
                  fillOpacity={0.8}
                  fontFamily="var(--font-sans)"
                  textAnchor={worstPoint.x > vbW / 2 ? "end" : "start"}
                  style={{ pointerEvents: "none" }}
                >
                  {m.trackdetail_worst_point()}
                </text>
                {/* Best point + callout */}
                <circle cx={bestPoint.x} cy={bestPoint.y} r="4" fill="var(--lap-record)" style={{ pointerEvents: "none" }} />
                <line x1={bestPoint.x} y1={bestPoint.y - 4} x2={bestPoint.x} y2={bestPoint.y - 14} stroke="var(--lap-record)" strokeOpacity={0.5} strokeWidth="0.5" />
                <text
                  x={bestPoint.x > vbW / 2 ? bestPoint.x - 4 : bestPoint.x + 4}
                  y={bestPoint.y - 16}
                  fontSize="8"
                  fill="var(--lap-record)"
                  fontFamily="var(--font-sans)"
                  textAnchor={bestPoint.x > vbW / 2 ? "end" : "start"}
                  style={{ pointerEvents: "none" }}
                >
                  {m.trackdetail_best_point()}
                </text>
                {/* Hover vertical line */}
                {hoveredIdx !== null && (
                  <line
                    x1={sparkPoints[hoveredIdx].x}
                    y1={padT}
                    x2={sparkPoints[hoveredIdx].x}
                    y2={padT + plotH}
                    stroke="var(--app-text)"
                    strokeOpacity={0.15}
                    strokeWidth="0.5"
                    strokeDasharray="2 2"
                    style={{ pointerEvents: "none" }}
                  />
                )}
              </svg>
              {/* Hover tooltip */}
              {hoveredIdx !== null &&
                (() => {
                  const p = sparkPoints[hoveredIdx];
                  const lap = chronoLaps[hoveredIdx];
                  const pctX = p.x / vbW;
                  return (
                    <div
                      className="absolute pointer-events-none z-10 bg-app-surface border border-app-border rounded px-2 py-1 text-app-compact font-mono text-app-text shadow-lg -translate-y-full"
                      style={{
                        left: `${Math.min(Math.max(pctX * 100, 5), 85)}%`,
                        top: `${(p.y / vbH) * 100}%`,
                        transform: "translate(-50%, -120%)",
                      }}
                    >
                      <div style={{ color: "var(--lap-record)" }}>{formatLapTime(lap.lapTime)}</div>
                      {lap.createdAt && <div className="text-app-text-dim">{new Date(lap.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}</div>}
                    </div>
                  );
                })()}
            </div>
          </div>
        )}

        {/* Theoretical best sectors */}
        {hasSectors && theoretical != null && (
          <div className="flex flex-col gap-2 border-t border-app-border pt-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-app-text-dim uppercase tracking-wider">
                {m.trackdetail_sectors()}
                <InfoTooltip position="bottom">{m.trackdetail_theoretical_best_tooltip()}</InfoTooltip>
              </div>
              {theoretical != null && (
                <div className="flex items-baseline gap-2 text-app-compact font-mono tabular-nums">
                  <span style={{ color: "var(--app-accent)" }}>{formatLapTime(theoretical)}</span>
                  {sectorGap != null && sectorGap > 0.001 && (
                    <>
                      <span className="text-app-text-dim">·</span>
                      <span style={{ color: "var(--delta-focus)" }}>+{formatLapTime(sectorGap)}</span>
                    </>
                  )}
                </div>
              )}
            </div>
            {/* Sector range bars */}
            {sectorStats &&
              (() => {
                const maxVarianceRange = Math.max(...sectorStats.map((s) => s.range));
                return sectorStats.map(({ label, min, max, med, range, medPct, p25Pct, p75Pct }, i) => {
                  const isWorstVariance = range === maxVarianceRange && sectorStats.length > 1;
                  const pctOfTheoretical = theoretical ? ((bestSectorTimes[i]! / theoretical) * 100).toFixed(0) : null;
                  return (
                    <div key={label} className="flex flex-col gap-0.5">
                      <div className="flex justify-between items-baseline">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-app-text-dim">{label}</span>
                          {pctOfTheoretical && <span className="text-app-caption text-app-text-muted">{pctOfTheoretical}%</span>}
                          {isWorstVariance && (
                            <span className="group/tip relative inline-flex items-center shrink-0 cursor-help">
                              <span className="text-app-micro" style={{ color: "var(--status-warning)", opacity: 0.8 }}>
                                ↔
                              </span>
                              <span className="absolute left-0 top-full mt-2 w-max max-w-[200px] hidden group-hover/tip:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1.5 text-app-caption text-app-text-secondary z-50 pointer-events-none leading-relaxed">
                                {m.trackdetail_most_variance_tooltip()}
                              </span>
                            </span>
                          )}
                        </div>
                        <div className="flex items-baseline gap-2 text-app-compact font-mono tabular-nums">
                          <span style={{ color: "var(--lap-record)" }}>{formatLapTime(min)}</span>
                          <span className="text-app-text-dim">·</span>
                          <span className="text-app-text-secondary">{formatLapTime(med)}</span>
                          <span className="text-app-text-dim">·</span>
                          <span className="text-app-text-dim">{formatLapTime(max)}</span>
                        </div>
                      </div>
                      <div className="relative h-1.5 bg-app-surface-alt rounded-full overflow-visible">
                        <div
                          className="absolute inset-0 rounded-full"
                          style={{
                            background: rangeBandGradient(p25Pct, p75Pct, 6, 20, 55),
                          }}
                        />
                        <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-2.5 rounded-sm shadow" style={{ left: `calc(${medPct}% - 3px)`, background: "var(--app-text)", opacity: 0.7 }} />
                      </div>
                    </div>
                  );
                });
              })()}
          </div>
        )}

        {/* Per-car best times */}
        {showCarBreakdown && (
          <div className="flex flex-col gap-1.5 border-t border-app-border pt-2.5">
            <div className="text-xs text-app-text-dim uppercase tracking-wider">{m.trackdetail_by_car()}</div>
            {carList.map((car, i) => {
              const barPct = 100 - ((car.bestTime - minT) / carRange) * 100;
              return (
                <div key={car.carOrdinal} className="flex flex-col gap-0.5">
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-app-text truncate max-w-[160px]" title={car.carName}>
                      {car.carName}
                    </span>
                    <span className="font-mono text-xs tabular-nums" style={{ color: i === 0 ? "var(--lap-record)" : "var(--app-text)" }}>
                      {formatLapTime(car.bestTime)}
                    </span>
                  </div>
                  <div className="h-1 bg-app-surface-alt rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: "var(--app-accent)", opacity: 0.4 }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* By lap number */}
        {showLapNumBreakdown && (
          <div className="flex flex-col gap-1.5 border-t border-app-border pt-2.5">
            <div className="text-xs text-app-text-dim uppercase tracking-wider">{m.trackdetail_by_lap_num()}</div>
            {lapNumData.map(({ lapNum, bestTime, count }) => {
              const barPct = 100 - ((bestTime - lapNumBest) / lapNumRange) * 100;
              const isFastest = bestTime === lapNumBest;
              return (
                <div key={lapNum} className="flex items-center gap-2">
                  <span className="text-xs text-app-text-secondary font-mono w-6 shrink-0 text-right">#{lapNum}</span>
                  <div className="flex-1 h-1.5 bg-app-surface-alt rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: "var(--app-accent)", opacity: 0.4 }} />
                  </div>
                  <span className="font-mono text-xs tabular-nums shrink-0" style={{ color: isFastest ? "var(--lap-record)" : "var(--app-text)" }}>
                    {formatLapTime(bestTime)}
                  </span>
                  <span className="text-app-compact text-app-text-secondary shrink-0">×{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* end scrollable body */}
    </div>
  );
}
