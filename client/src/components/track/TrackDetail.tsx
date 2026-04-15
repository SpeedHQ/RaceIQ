import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { isDevelopment } from "@/lib/env";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { formatLapTime } from "@/lib/format";
import { useBulkDeleteLaps } from "@/hooks/queries";
import { useGameId } from "@/stores/game";
import { client } from "@/lib/rpc";
import { drawTrack } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import { F125SetupsWithGuide, F125TrackGuide } from "@/components/f1/F125TrackSetups";
import { F125Leaderboard } from "@/components/f1/F125Leaderboard";
import { AccTrackSetups, AccTrackGuide } from "@/components/acc/AccTrackSetups";
import { TrackTunes } from "./TrackTunes";
import { Button } from "@/components/ui/button";
import { Table, THead, TH, TBody, TRow, TD } from "@/components/ui/AppTable";
import { TrackDebugPanel } from "./debug/TrackDebugPanel";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import type { TrackInfo, Point, TrackSegment, TrackSectors } from "./types";

interface TrackLap {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  carName: string;
  carClass: string;
  pi: number;
  createdAt?: string;
  sessionId?: number | null;
  s1Time?: number | null;
  s2Time?: number | null;
  s3Time?: number | null;
  isValid?: boolean;
  invalidReason?: string | null;
  division?: string | null;
  notes?: string | null;
}

function LapStatsPanel({ laps, showSessionFilter }: { laps: TrackLap[]; showSessionFilter?: boolean }) {
  const [lapFilter, setLapFilter] = useState<null | "race" | "quali">(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  if (laps.length === 0) return null;

  const sessionCounts = new Map<number, number>();
  if (showSessionFilter) {
    for (const l of laps) {
      if (l.sessionId != null) sessionCounts.set(l.sessionId, (sessionCounts.get(l.sessionId) ?? 0) + 1);
    }
  }
  const hasRaceFilter = showSessionFilter && [...sessionCounts.values()].some(c => c > 1);
  const filteredLaps = showSessionFilter && lapFilter === "race"
    ? laps.filter(l => l.sessionId != null && (sessionCounts.get(l.sessionId) ?? 0) > 1)
    : showSessionFilter && lapFilter === "quali"
    ? laps.filter(l => l.sessionId == null || (sessionCounts.get(l.sessionId) ?? 0) === 1)
    : laps;

  // All stats use the most recent 100 valid laps (chronological)
  const chronoLaps = [...filteredLaps.filter(l => l.isValid !== false)]
    .sort((a, b) => a.lapId - b.lapId)
    .slice(-100);

  const times = [...chronoLaps.map(l => l.lapTime)].sort((a, b) => a - b);
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
  const trendDir = chronoLaps.length >= 4
    ? trendDelta < -trendThreshold ? "faster" : trendDelta > trendThreshold ? "slower" : "neutral"
    : "neutral";

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
  const polyline = sparkPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const bestPoint = sparkPoints.reduce((b, p) => p.y > b.y ? p : b, sparkPoints[0]);
  const worstPoint = sparkPoints.reduce((b, p) => p.y < b.y ? p : b, sparkPoints[0]);
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
  const lapsWithSectors = chronoLaps.filter(l => l.s1Time != null && l.s2Time != null && l.s3Time != null);
  const hasSectors = lapsWithSectors.length > 0;
  const bestS1 = hasSectors ? Math.min(...lapsWithSectors.map(l => l.s1Time!)) : null;
  const bestS2 = hasSectors ? Math.min(...lapsWithSectors.map(l => l.s2Time!)) : null;
  const bestS3 = hasSectors ? Math.min(...lapsWithSectors.map(l => l.s3Time!)) : null;
  const theoretical = hasSectors ? bestS1! + bestS2! + bestS3! : null;
  const sectorGap = theoretical != null ? minT - theoretical : null;

  // Sector range stats for mini range bars
  const sectorStats = hasSectors ? ([1, 2, 3] as const).map(s => {
    const key = `s${s}Time` as "s1Time" | "s2Time" | "s3Time";
    const vals = lapsWithSectors.map(l => l[key]!).sort((a, b) => a - b);
    const mn = vals[0];
    const mx = vals[vals.length - 1];
    const rng = mx - mn || 1;
    const midI = Math.floor(vals.length / 2);
    const med = vals.length % 2 === 0 ? (vals[midI - 1] + vals[midI]) / 2 : vals[midI];
    const p25v = vals[Math.floor((vals.length - 1) * 0.25)];
    const p75v = vals[Math.floor((vals.length - 1) * 0.75)];
    return {
      label: `S${s}`,
      min: mn, max: mx, med,
      range: mx - mn,
      medPct: ((med - mn) / rng) * 100,
      p25Pct: ((p25v - mn) / rng) * 100,
      p75Pct: ((p75v - mn) / rng) * 100,
    };
  }) : null;

  // Per-car best times
  const carBests = new Map<number, { carName: string; bestTime: number }>();
  for (const lap of chronoLaps) {
    const existing = carBests.get(lap.carOrdinal);
    if (!existing || lap.lapTime < existing.bestTime) {
      carBests.set(lap.carOrdinal, { carName: lap.carName, bestTime: lap.lapTime });
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
  const lapNumWorst = lapNumData.length > 0 ? Math.max(...lapNumData.map(d => d.bestTime)) : maxT;
  const lapNumBest = lapNumData.length > 0 ? Math.min(...lapNumData.map(d => d.bestTime)) : minT;
  const lapNumRange = lapNumWorst - lapNumBest || 1;
  const showLapNumBreakdown = lapNumData.length > 1;

  return (
    <div className="w-2/5 min-w-0 bg-app-surface/50 border border-app-border rounded-lg flex flex-col overflow-hidden">
      {/* Fixed header — outside scroll container */}
      <div className="flex justify-between items-center px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider">Stats</div>
          {hasRaceFilter && (
            <div className="flex rounded overflow-hidden border border-app-border text-xs">
              {(["race", "quali"] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setLapFilter(lapFilter === f ? null : f)}
                  className={`px-2 py-1 transition-colors capitalize ${
                    lapFilter === f
                      ? f === "race"
                        ? "bg-emerald-900/60 text-emerald-400 border-r border-app-border"
                        : "bg-amber-900/60 text-amber-400"
                      : "text-app-text-dim hover:text-app-text-secondary" + (f === "race" ? " border-r border-app-border" : "")
                  }`}
                >
                  {f === "race" ? "Race" : "Quali"}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="text-[11px] text-app-text-dim font-mono">last 100</div>
      </div>
      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[
          { label: "Best", value: minT, color: "text-purple-400" },
          { label: "Median", value: medT, color: "text-app-text" },
          { label: "Worst", value: maxT, color: "text-app-text" },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <div className="text-xs text-app-text-dim uppercase tracking-wider">{label}</div>
            <div className={`font-mono text-app-body tabular-nums ${color}`}>{formatLapTime(value)}</div>
          </div>
        ))}
      </div>
      {/* Range bar */}
      <div className="flex flex-col gap-1">
        <div className="relative h-2 bg-app-surface-alt rounded-full overflow-visible">
          <div className="absolute inset-0 rounded-full" style={{ background: `linear-gradient(to right, rgb(255 255 255 / 0.08) 0%, rgb(255 255 255 / 0.08) ${p25Pct}%, rgb(52 211 153 / 0.25) ${p25Pct}%, rgb(52 211 153 / 0.65) ${(p25Pct + p75Pct) / 2}%, rgb(52 211 153 / 0.25) ${p75Pct}%, rgb(255 255 255 / 0.08) ${p75Pct}%, rgb(255 255 255 / 0.08) 100%)` }} />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-2 h-3 bg-white/80 rounded-sm shadow"
            style={{ left: `calc(${medPct}% - 4px)` }}
          />
        </div>
        <div className="flex justify-between items-center text-[11px] text-app-text-secondary font-mono">
          <span>{formatLapTime(minT)}</span>
          <span className="flex items-center gap-1 text-[10px] text-app-text-dim font-sans">
            <span className="inline-block w-2.5 h-1.5 rounded-sm bg-emerald-300/70" />
            typical range
          </span>
          <span>{formatLapTime(maxT)}</span>
        </div>
      </div>
      {/* Lap time trend sparkline */}
      {chronoLaps.length >= 2 && (
        <div className="flex flex-col gap-0.5 border-t border-app-border pt-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="text-xs text-app-text-dim uppercase tracking-wider">Trend</div>
            {trendDir === "faster" && <span className="text-xs text-emerald-400 font-medium">↓ Faster</span>}
            {trendDir === "slower" && <span className="text-xs text-red-400 font-medium">↑ Slower</span>}
            {trendDir === "neutral" && chronoLaps.length >= 4 && <span className="text-xs text-app-text-secondary font-medium">→ Keeping pace</span>}
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
                let minDist = Infinity;
                sparkPoints.forEach((p, i) => {
                  const d = Math.abs(p.x - svgX);
                  if (d < minDist) { minDist = d; closest = i; }
                });
                setHoveredIdx(closest);
              }}
            >
              <defs>
                <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={trendDir === "faster" ? "rgb(52 211 153)" : trendDir === "slower" ? "rgb(248 113 113)" : "rgb(255 255 255)"} stopOpacity="0.15" />
                  <stop offset="100%" stopColor={trendDir === "faster" ? "rgb(52 211 153)" : trendDir === "slower" ? "rgb(248 113 113)" : "rgb(255 255 255)"} stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* Grid lines */}
              <line x1={padL} y1={padT} x2={padL + plotW} y2={padT} stroke="rgb(255 255 255 / 0.06)" strokeWidth="0.5" />
              <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="rgb(255 255 255 / 0.06)" strokeWidth="0.5" />
              {/* Axis lines */}
              <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="rgb(255 255 255 / 0.08)" strokeWidth="0.5" />
              <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="rgb(255 255 255 / 0.08)" strokeWidth="0.5" />
              {/* Area fill */}
              <polygon
                points={`${polyline} ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)} ${padL},${(padT + plotH).toFixed(1)}`}
                fill="url(#areaFill)"
              />
              {/* Axis labels */}
              <text x={padL} y={vbH - 2} fontSize="8" fill="rgb(255 255 255 / 0.3)" fontFamily="sans-serif">Older</text>
              <text x={padL + plotW - 30} y={vbH - 2} fontSize="8" fill="rgb(255 255 255 / 0.3)" fontFamily="sans-serif">{lastDate}</text>
              {/* Trend line */}
              <line
                x1={trendX1.toFixed(1)} y1={trendY1.toFixed(1)}
                x2={trendX2.toFixed(1)} y2={trendY2.toFixed(1)}
                stroke={trendDir === "faster" ? "rgb(52 211 153 / 0.6)" : trendDir === "slower" ? "rgb(248 113 113 / 0.6)" : "rgb(255 255 255 / 0.2)"}
                strokeWidth="1"
                strokeDasharray="3 2"
              />
              {/* Sparkline */}
              <polyline points={polyline} fill="none" stroke="rgb(192 132 252 / 0.5)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              {/* Visible dots */}
              {sparkPoints.map((p, i) => (
                <circle
                  key={`dot-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={hoveredIdx === i ? 3 : 1.5}
                  fill={hoveredIdx === i ? "rgb(255 255 255)" : "rgb(192 132 252 / 0.4)"}
                  style={{ pointerEvents: "none" }}
                />
              ))}
              {/* Worst point */}
              <circle cx={worstPoint.x} cy={worstPoint.y} r="4" fill="rgb(248 113 113 / 0.7)" style={{ pointerEvents: "none" }} />
              <line x1={worstPoint.x} y1={worstPoint.y - 4} x2={worstPoint.x} y2={worstPoint.y - 14} stroke="rgb(248 113 113 / 0.5)" strokeWidth="0.5" />
              <text
                x={worstPoint.x > vbW / 2 ? worstPoint.x - 4 : worstPoint.x + 4}
                y={worstPoint.y - 16}
                fontSize="8"
                fill="rgb(248 113 113 / 0.8)"
                fontFamily="sans-serif"
                textAnchor={worstPoint.x > vbW / 2 ? "end" : "start"}
                style={{ pointerEvents: "none" }}
              >Worst</text>
              {/* Best point + callout */}
              <circle cx={bestPoint.x} cy={bestPoint.y} r="4" fill="rgb(192 132 252)" style={{ pointerEvents: "none" }} />
              <line x1={bestPoint.x} y1={bestPoint.y - 4} x2={bestPoint.x} y2={bestPoint.y - 14} stroke="rgb(192 132 252 / 0.5)" strokeWidth="0.5" />
              <text
                x={bestPoint.x > vbW / 2 ? bestPoint.x - 4 : bestPoint.x + 4}
                y={bestPoint.y - 16}
                fontSize="8"
                fill="rgb(192 132 252)"
                fontFamily="sans-serif"
                textAnchor={bestPoint.x > vbW / 2 ? "end" : "start"}
                style={{ pointerEvents: "none" }}
              >Best</text>
              {/* Hover vertical line */}
              {hoveredIdx !== null && (
                <line
                  x1={sparkPoints[hoveredIdx].x}
                  y1={padT}
                  x2={sparkPoints[hoveredIdx].x}
                  y2={padT + plotH}
                  stroke="rgb(255 255 255 / 0.15)"
                  strokeWidth="0.5"
                  strokeDasharray="2 2"
                  style={{ pointerEvents: "none" }}
                />
              )}
            </svg>
            {/* Hover tooltip */}
            {hoveredIdx !== null && (() => {
              const p = sparkPoints[hoveredIdx];
              const lap = chronoLaps[hoveredIdx];
              const pctX = p.x / vbW;
              return (
                <div
                  className="absolute pointer-events-none z-10 bg-app-surface border border-app-border rounded px-2 py-1 text-[11px] font-mono text-app-text shadow-lg -translate-y-full"
                  style={{
                    left: `${Math.min(Math.max(pctX * 100, 5), 85)}%`,
                    top: `${(p.y / vbH) * 100}%`,
                    transform: "translate(-50%, -120%)",
                  }}
                >
                  <div className="text-purple-400">{formatLapTime(lap.lapTime)}</div>
                  {lap.createdAt && (
                    <div className="text-app-text-dim">{new Date(lap.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}</div>
                  )}
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
              Sectors
              <InfoTooltip position="bottom">Theoretical best = best S1 + best S2 + best S3 across all laps. Gap = time between your best lap and theoretical best.</InfoTooltip>
            </div>
            {theoretical != null && (
              <div className="flex items-baseline gap-2 text-[11px] font-mono tabular-nums">
                <span className="text-cyan-400">{formatLapTime(theoretical)}</span>
                {sectorGap != null && sectorGap > 0.001 && <><span className="text-app-text-dim">·</span><span className="text-amber-400">+{formatLapTime(sectorGap)}</span></>}
              </div>
            )}
          </div>
          {/* Sector range bars */}
          {sectorStats && (() => {
            const maxVarianceRange = Math.max(...sectorStats.map(s => s.range));
            const bestSectorTimes = [bestS1, bestS2, bestS3];
            return sectorStats.map(({ label, min, max, med, range, medPct, p25Pct, p75Pct }, i) => {
              const isWorstVariance = range === maxVarianceRange && sectorStats.length > 1;
              const pctOfTheoretical = theoretical ? ((bestSectorTimes[i]! / theoretical) * 100).toFixed(0) : null;
              return (
                <div key={label} className="flex flex-col gap-0.5">
                  <div className="flex justify-between items-baseline">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-app-text-dim">{label}</span>
                      {pctOfTheoretical && <span className="text-[10px] text-app-text-muted">{pctOfTheoretical}%</span>}
                      {isWorstVariance && (
                        <span className="group/tip relative inline-flex items-center shrink-0 cursor-help">
                          <span className="text-[9px] text-amber-400/80">↔</span>
                          <span className="absolute left-0 top-full mt-2 w-max max-w-[200px] hidden group-hover/tip:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1.5 text-[10px] text-app-text-secondary z-50 pointer-events-none leading-relaxed">
                            Most variance — largest time spread across laps. Most time lost/gained here.
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-2 text-[11px] font-mono tabular-nums">
                      <span className="text-purple-400">{formatLapTime(min)}</span>
                      <span className="text-app-text-dim">·</span>
                      <span className="text-app-text-secondary">{formatLapTime(med)}</span>
                      <span className="text-app-text-dim">·</span>
                      <span className="text-app-text-dim">{formatLapTime(max)}</span>
                    </div>
                  </div>
                  <div className="relative h-1.5 bg-app-surface-alt rounded-full overflow-visible">
                    <div
                      className="absolute inset-0 rounded-full"
                      style={{ background: `linear-gradient(to right, rgb(255 255 255 / 0.06) 0%, rgb(255 255 255 / 0.06) ${p25Pct}%, rgb(52 211 153 / 0.2) ${p25Pct}%, rgb(52 211 153 / 0.55) ${(p25Pct + p75Pct) / 2}%, rgb(52 211 153 / 0.2) ${p75Pct}%, rgb(255 255 255 / 0.06) ${p75Pct}%, rgb(255 255 255 / 0.06) 100%)` }}
                    />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-1.5 h-2.5 bg-white/70 rounded-sm shadow"
                      style={{ left: `calc(${medPct}% - 3px)` }}
                    />
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
          <div className="text-xs text-app-text-dim uppercase tracking-wider">By Car</div>
          {carList.map((car, i) => {
            const barPct = 100 - ((car.bestTime - minT) / carRange) * 100;
            return (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="flex justify-between items-baseline">
                  <span className="text-xs text-app-text truncate max-w-[160px]" title={car.carName}>{car.carName}</span>
                  <span className={`font-mono text-xs tabular-nums ${i === 0 ? "text-purple-400" : "text-app-text"}`}>{formatLapTime(car.bestTime)}</span>
                </div>
                <div className="h-1 bg-app-surface-alt rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-400/40 rounded-full" style={{ width: `${barPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* By lap number */}
      {showLapNumBreakdown && (
        <div className="flex flex-col gap-1.5 border-t border-app-border pt-2.5">
          <div className="text-xs text-app-text-dim uppercase tracking-wider">By Lap #</div>
          {lapNumData.map(({ lapNum, bestTime, count }) => {
            const barPct = 100 - ((bestTime - lapNumBest) / lapNumRange) * 100;
            const isFastest = bestTime === lapNumBest;
            return (
              <div key={lapNum} className="flex items-center gap-2">
                <span className="text-xs text-app-text-secondary font-mono w-6 shrink-0 text-right">#{lapNum}</span>
                <div className="flex-1 h-1.5 bg-app-surface-alt rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-400/40 rounded-full" style={{ width: `${barPct}%` }} />
                </div>
                <span className={`font-mono text-xs tabular-nums shrink-0 ${isFastest ? "text-purple-400" : "text-app-text"}`}>{formatLapTime(bestTime)}</span>
                <span className="text-[11px] text-app-text-secondary shrink-0">×{count}</span>
              </div>
            );
          })}
        </div>
      )}
      </div>{/* end scrollable body */}
    </div>
  );
}

/**
 * TrackDetail — Full-size track view with segment overlay and stats sidebar.
 * Fetches both outline and sector data; segments are color-coded (red=corner, blue=straight).
 */
export function TrackDetail({ track, onBack, initialTab, navigate }: { track: TrackInfo; onBack: () => void; initialTab?: string; navigate: ReturnType<typeof useNavigate> }) {
  const gameId = useGameId();
  const gid = gameId ?? undefined;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [flipX, setFlipX] = useState(false);
  const [sectors, setSectors] = useState<TrackSectors | null>(null);
  const [segSource, setSegSource] = useState<string>(""); // "user" | "extracted" | "named" | "shared" | "auto"

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, z: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, z: 0 });
  zoomRef.current = zoom;
  panRef.current = pan;
  const dragging = useRef<{ startX: number; startY: number; startPanX: number; startPanZ: number } | null>(null);
  const [mapDisplayMode, setMapDisplayMode] = useState<"segments" | "sectors">("segments");
  const [editing, setEditing] = useState(false);
  const [editSegments, setEditSegments] = useState<TrackSegment[]>([]);
  const [saving, setSaving] = useState(false);
  const [sectorBounds, setSectorBounds] = useState<{ s1End: number; s2End: number } | null>(null);
  const [editingSectors, setEditingSectors] = useState(false);
  const [editS1, setEditS1] = useState(33.3);
  const [editS2, setEditS2] = useState(66.6);
  const [savingSectors, setSavingSectors] = useState(false);
  const [selectedDivision, setSelectedDivision] = useState<string | null>(null);
  const [selectedCars, setSelectedCars] = useState<Set<number>>(new Set());
  const [carSearch, setCarSearch] = useState("");
  const [carDropdownOpen, setCarDropdownOpen] = useState(false);
  const carDropdownRef = useRef<HTMLDivElement>(null);
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<"time" | "lap" | "date">("time");
  const [sortAsc, setSortAsc] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isF125 = gameId === "f1-2025";
  const isAcc = gameId === "acc";

  // F1 25 track video — shown beside map on setups tab
  const hasForzaTunes = !gameId || gameId === "fm-2023";
  const allTabs = hasForzaTunes ? ["laps", "tunes", "debug"] as const
    : isF125 ? ["laps", "setups", "guide", "debug"] as const
    : isAcc ? ["laps", "setups", "guide", "debug"] as const
    : ["laps", "debug"] as const;
  type Tab = typeof allTabs[number];
  const validTabs = allTabs;
  const [activeTab, setActiveTabState] = useState<Tab>(
    (validTabs as readonly string[]).includes(initialTab as string) ? (initialTab as Tab) : "laps"
  );
  const setActiveTab = useCallback((tab: Tab) => {
    setActiveTabState(tab);
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, tab: tab === "laps" ? undefined : tab }) as never, replace: true });
  }, [navigate]);
  const navTo = useNavigate();

  const { data: trackMapData } = useQuery({
    queryKey: ["track-map", track.ordinal, gameId ?? null],
    queryFn: () => Promise.all([
      client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid ?? undefined } }).then((r) => r.json() as unknown as { points?: Point[]; flipX?: boolean } | Point[]),
      client.api["track-sectors"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid! } }).then((r) => r.json() as unknown as (TrackSectors & { source?: string }) | null),
      client.api["track-sector-boundaries"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid! } }).then((r) => r.json() as unknown as { s1End: number; s2End: number } | null),
    ]).then(([outlineData, sectorData, boundsData]) => ({ outlineData, sectorData, boundsData })),
    enabled: track.hasOutline && !!gameId,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!trackMapData) return;
    const { outlineData, sectorData, boundsData } = trackMapData;
    if (!Array.isArray(outlineData) && outlineData?.points && Array.isArray(outlineData.points)) {
      setOutline(outlineData.points);
      setFlipX(outlineData.flipX ?? false);
    } else if (Array.isArray(outlineData)) {
      setOutline(outlineData as Point[]);
    } else {
      setOutline(null);
    }
    setSectors(sectorData);
    setSegSource((sectorData as (TrackSectors & { source?: string }) | null)?.source ?? "");
    if (boundsData?.s1End) setSectorBounds(boundsData);
  }, [trackMapData]);

  // Fetch all laps for this track
  const { data: trackLapsData = [], refetch: refetchLaps } = useQuery<TrackLap[]>({
    queryKey: ["track-laps", track.ordinal, gameId ?? null],
    queryFn: () => client.api.tracks[":trackOrdinal"]["all-laps"].$get({ param: { trackOrdinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } } as never)
      .then((r) => r.json() as unknown as TrackLap[] | null)
      .then((data) => data ?? []),
    staleTime: 30 * 1000,
  });

  const trackLaps = trackLapsData;


  // Use edit segments for preview when editing, otherwise use fetched sectors
  const displaySectors = editing && editSegments.length > 0
    ? { segments: editSegments, totalDist: sectors?.totalDist ?? 0 }
    : sectors;

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    const showSectors = editingSectors || mapDisplayMode === "sectors";
    const sectorBoundsForDraw = editingSectors
      ? { s1End: editS1 / 100, s2End: editS2 / 100 }
      : sectorBounds ?? undefined;
    const sectorOverride = showSectors ? sectorBoundsForDraw : undefined;
    drawTrack(canvasRef.current, outline, true, showSectors ? null : displaySectors, zoom, pan, sectorOverride, flipX);
  }, [outline, displaySectors, zoom, pan, editingSectors, editS1, editS2, mapDisplayMode, sectorBounds, activeTab, flipX]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const factor = Math.pow(0.999, e.deltaY);
      const newZoom = Math.min(Math.max(currentZoom * factor, 0.5), 4);
      if (Math.abs(newZoom - currentZoom) < 0.001) return;

      if (newZoom <= 0.51) {
        setZoom(1);
        setPan({ x: 0, z: 0 });
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ratio = newZoom / currentZoom;
      setZoom(newZoom);
      setPan({
        x: mouseX - cx - (mouseX - cx - currentPan.x) * ratio,
        z: mouseY - cy - (mouseY - cy - currentPan.z) * ratio,
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const startEditing = useCallback(() => {
    if (sectors?.segments) {
      setEditSegments(sectors.segments.map((s) => ({ ...s })));
      setEditing(true);
    }
  }, [sectors]);

  const updateSegFrac = useCallback((idx: number, field: "startFrac" | "endFrac", value: number) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx][field] = value;
      // Auto-chain: if changing endFrac, update next segment's startFrac
      if (field === "endFrac" && idx + 1 < next.length) {
        next[idx + 1].startFrac = value;
      }
      // Auto-chain: if changing startFrac, update prev segment's endFrac
      if (field === "startFrac" && idx > 0) {
        next[idx - 1].endFrac = value;
      }
      return next;
    });
  }, []);

  const updateSegName = useCallback((idx: number, name: string) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx].name = name;
      return next;
    });
  }, []);

  const toggleSegType = useCallback((idx: number) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx].type = next[idx].type === "corner" ? "straight" : "corner";
      // Clear name when type changes so display auto-name kicks in
      next[idx].name = "";
      return next;
    });
  }, []);

  const addSegment = useCallback((afterIdx: number) => {
    setEditSegments((prev) => {
      const next = [...prev];
      const current = next[afterIdx];
      const midFrac = (current.startFrac + current.endFrac) / 2;
      const newType = current.type === "corner" ? "straight" : "corner";
      const newSeg: TrackSegment = {
        type: newType,
        name: newType === "straight" ? "S?" : "T?",
        startFrac: midFrac,
        endFrac: current.endFrac,
        startIdx: 0,
        endIdx: 0,
      };
      next[afterIdx] = { ...current, endFrac: midFrac };
      next.splice(afterIdx + 1, 0, newSeg);
      return next;
    });
  }, []);

  const removeSegment = useCallback((idx: number) => {
    setEditSegments((prev) => {
      if (prev.length <= 1) return prev;
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      // Extend the previous segment to cover the gap
      if (idx > 0) {
        next[idx - 1] = { ...next[idx - 1], endFrac: removed.endFrac };
      } else if (next.length > 0) {
        next[0] = { ...next[0], startFrac: removed.startFrac };
      }
      return next;
    });
  }, []);

  const saveSegments = useCallback(async () => {
    setSaving(true);
    try {
      const res = await client.api.tracks[":trackOrdinal"].segments.$put({ param: { trackOrdinal: String(track.ordinal) }, query: { gameId: gid }, json: { segments: editSegments } } as never);
      if (res.ok) {
        setSectors({ segments: editSegments, totalDist: sectors?.totalDist ?? 0 });
        setEditing(false);
      }
    } catch {}
    setSaving(false);
  }, [editSegments, track.ordinal, sectors]);

  const startEditingSectors = useCallback(() => {
    if (sectorBounds) {
      setEditS1(Math.round(sectorBounds.s1End * 1000) / 10);
      setEditS2(Math.round(sectorBounds.s2End * 1000) / 10);
    }
    setEditingSectors(true);
  }, [sectorBounds]);

  const saveSectorBounds = useCallback(async () => {
    setSavingSectors(true);
    try {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$put({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid }, json: { s1End: editS1 / 100, s2End: editS2 / 100 } } as never);
      if (res.ok) {
        setSectorBounds({ s1End: editS1 / 100, s2End: editS2 / 100 });
        setEditingSectors(false);
      }
    } catch {}
    setSavingSectors(false);
  }, [editS1, editS2, track.ordinal]);

  // Build display names: auto-number empty/unnamed straights
  const segDisplayNames = useMemo(() => {
    const segs = editing ? editSegments : (displaySectors?.segments ?? []);
    let sNum = 1;
    return segs.map((s) => {
      if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) {
        return `S${sNum++}`;
      }
      if (s.type === "straight") sNum++;
      return s.name;
    });
  }, [editing, editSegments, displaySectors]);

  const corners = displaySectors?.segments.filter((s) => s.type === "corner") ?? [];
  const straights = displaySectors?.segments.filter((s) => s.type === "straight") ?? [];

  // Lap manager: unique cars, filtered & sorted laps
  const uniqueCars = useMemo(() => {
    const map = new Map<number, { carOrdinal: number; carName: string; carClass: string }>();
    for (const l of trackLaps) {
      if (!map.has(l.carOrdinal)) map.set(l.carOrdinal, { carOrdinal: l.carOrdinal, carName: l.carName, carClass: l.carClass });
    }
    return Array.from(map.values()).sort((a, b) => a.carName.localeCompare(b.carName));
  }, [trackLaps]);

  const uniqueDivisions = useMemo(() => {
    const divs = new Set(trackLaps.map(l => l.division).filter((d): d is string => !!d));
    return [...divs].sort();
  }, [trackLaps]);

  const filteredLaps = useMemo(() => {
    return trackLaps
      .filter((l) => selectedCars.size === 0 || selectedCars.has(l.carOrdinal))
      .filter((l) => !selectedDivision || l.division === selectedDivision)
      .sort((a, b) => {
        const cmp = sortBy === "time" ? a.lapTime - b.lapTime : sortBy === "date" ? (new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()) : a.lapNumber - b.lapNumber;
        return sortAsc ? cmp : -cmp;
      });
  }, [trackLaps, selectedCars, selectedDivision, sortBy, sortAsc]);

  const sessionLapCounts = useMemo(() => {
    if (!isF125) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const l of trackLaps) {
      if (l.sessionId != null) counts.set(l.sessionId, (counts.get(l.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [isF125, trackLaps]);
  const hasSessionTypes = useMemo(() => {
    if (!isF125) return false;
    const vals = [...sessionLapCounts.values()];
    return vals.some(c => c > 1) && vals.some(c => c === 1);
  }, [isF125, sessionLapCounts]);

  const hasSectorData = useMemo(() => trackLaps.some(l => l.s1Time != null), [trackLaps]);

  const toggleCar = useCallback((ord: number) => {
    setSelectedCars((prev) => {
      const next = new Set(prev);
      if (next.has(ord)) next.delete(ord); else next.add(ord);
      return next;
    });
    setSelectedLaps(new Set());
  }, []);

  useEffect(() => {
    if (!carDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (carDropdownRef.current && !carDropdownRef.current.contains(e.target as Node)) {
        setCarDropdownOpen(false);
        setCarSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [carDropdownOpen]);

  const toggleLapSelect = useCallback((lapId: number) => {
    setSelectedLaps((prev) => {
      const next = new Set(prev);
      if (next.has(lapId)) next.delete(lapId); else next.add(lapId);
      return next;
    });
  }, []);

  const toggleAllLaps = useCallback(() => {
    if (selectedLaps.size === filteredLaps.length) setSelectedLaps(new Set());
    else setSelectedLaps(new Set(filteredLaps.map((l) => l.lapId)));
  }, [selectedLaps.size, filteredLaps]);

  const bulkDelete = useBulkDeleteLaps();
  const handleBulkDelete = useCallback(async () => {
    if (selectedLaps.size === 0) return;
    setDeleting(true);
    try {
      await bulkDelete.mutateAsync(Array.from(selectedLaps));
      setSelectedLaps(new Set());
      setConfirmDelete(false);
      void refetchLaps();
    } catch {}
    setDeleting(false);
  }, [selectedLaps, refetchLaps, bulkDelete]);

  const handleSort = useCallback((col: "time" | "lap" | "date") => {
    if (sortBy === col) setSortAsc((a) => !a);
    else { setSortBy(col); setSortAsc(true); }
  }, [sortBy]);

  const classTextColors: Record<string, string> = {
    X: "text-green-700", P: "text-green-400", R: "text-blue-400",
    S: "text-purple-400", A: "text-red-400",
    B: "text-orange-400", C: "text-yellow-400", D: "text-cyan-400", E: "text-pink-400",
  };

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="text-app-label text-app-text-secondary hover:text-app-text px-2 py-1 rounded bg-app-surface-alt hover:bg-app-border-input transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <div className="text-app-heading font-semibold text-app-text">{track.name}</div>
          <div className="text-app-label text-app-text-muted">
            {track.variant} · {track.location}, {countryName(track.country)}
            {track.lengthKm > 0 && ` · ${track.lengthKm} km`}
          </div>
        </div>
        {/* View mode tabs */}
        <div className="flex items-center gap-1">
          {validTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`text-app-label uppercase tracking-wider px-3 py-1.5 rounded transition-colors ${
                activeTab === tab
                  ? tab === "debug" ? "bg-amber-500/15 text-amber-500" : "bg-app-accent/15 text-app-accent"
                  : "text-app-text-muted hover:text-app-text-secondary hover:bg-app-surface-alt"
              }`}
            >
              {tab === "laps" && trackLaps.length > 0 ? `Laps (${trackLaps.length})` : tab === "guide" ? "Guides" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Debug: full-page view with segments/sectors sidebar */}
      {activeTab === "debug" ? (
        <div className="flex gap-4 h-[calc(100vh-160px)]">
          <div className="flex-1 min-h-0 overflow-hidden">
            <TrackDebugPanel
              trackOrdinal={track.ordinal}
              outline={outline}
              flipX={flipX}
              displaySectors={displaySectors}
              sectorBounds={editingSectors ? { s1End: editS1 / 100, s2End: editS2 / 100 } : sectorBounds}
              editingSegments={editing}
              editingSectors={editingSectors}
              trackLengthKm={track.lengthKm}
              trackCreatedAt={track.createdAt ?? undefined}
              corners={corners.length}
              straights={straights.length}
            />
          </div>
          <div className="w-80 shrink-0 flex flex-col gap-3 overflow-auto">
            {/* Segment list / editor */}
            {displaySectors && displaySectors.segments.length > 0 && (
              <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-app-label text-app-text-muted uppercase tracking-wider">Segments</span>
                    {segSource && (
                      <span className="text-[9px] font-mono text-app-text-dim px-1 py-0.5 rounded bg-app-surface-alt border border-app-border-input">
                        {segSource}
                      </span>
                    )}
                  </div>
                  {isDevelopment && (!editing ? (
                    <button onClick={startEditing} className="text-app-unit text-cyan-400 hover:text-cyan-300 px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-800/50">Edit</button>
                  ) : (
                    <div className="flex gap-1">
                      <button onClick={saveSegments} disabled={saving} className="text-app-unit text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-900/30 border border-emerald-800/50 disabled:opacity-50">{saving ? "..." : "Save"}</button>
                      <button onClick={() => setEditing(false)} className="text-app-unit text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input">Cancel</button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-0.5 max-h-[300px] overflow-auto">
                  {(editing ? editSegments : displaySectors.segments).map((seg, i) => {
                    const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
                    const isCorner = seg.type === "corner";
                    const color = isCorner ? "text-red-400" : "text-blue-400";
                    const bg = isCorner ? "bg-red-500/10" : "bg-blue-500/10";
                    if (!editing) {
                      return (
                        <div key={i} className={`flex items-center justify-between px-2 py-1 rounded ${bg}`}>
                          <div className="flex items-center gap-2">
                            <span className={`text-app-label font-mono font-bold ${color}`}>{segDisplayNames[i]}</span>
                            <span className="text-app-label text-app-text-muted capitalize">{seg.type}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {track.lengthKm > 0 && <span className="text-app-label font-mono text-app-text-dim">{((seg.endFrac - seg.startFrac) * track.lengthKm).toFixed(2)} km</span>}
                            <span className="text-app-label font-mono text-app-text-secondary">{pct}%</span>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={i} className={`px-2 py-1.5 rounded ${bg} space-y-1`}>
                        <div className="flex items-center gap-1">
                          <button onClick={() => toggleSegType(i)} className={`text-app-unit font-bold px-1 rounded ${isCorner ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>{isCorner ? "T" : "S"}</button>
                          <input value={seg.name} placeholder={segDisplayNames[i]} onChange={(e) => updateSegName(i, e.target.value)} className="flex-1 text-app-label font-mono bg-transparent border-b border-app-border-input text-app-text outline-none px-1 placeholder:text-app-text-dim" />
                          <button onClick={() => addSegment(i)} className="text-app-unit text-app-text-muted hover:text-app-text px-1" title="Split segment">+</button>
                          <button onClick={() => removeSegment(i)} className="text-app-unit text-app-text-muted hover:text-red-400 px-1" title="Remove segment">x</button>
                        </div>
                        <div className="flex items-center gap-2 text-app-label font-mono text-app-text-secondary">
                          <input type="number" step="0.1" min="0" max="100" value={(seg.startFrac * 100).toFixed(1)} onChange={(e) => updateSegFrac(i, "startFrac", Number(e.target.value) / 100)} className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                          <span>-</span>
                          <input type="number" step="0.1" min="0" max="100" value={(seg.endFrac * 100).toFixed(1)} onChange={(e) => updateSegFrac(i, "endFrac", Number(e.target.value) / 100)} className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                          <span className="text-app-text-dim">({pct}%)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Sector Boundaries */}
            <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-app-label text-app-text-muted uppercase tracking-wider">Sector Boundaries</div>
                {isDevelopment && (!editingSectors ? (
                  <button onClick={startEditingSectors} disabled={!sectorBounds} className="text-app-unit text-cyan-400 hover:text-cyan-300 px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-800/50 disabled:opacity-50">Edit</button>
                ) : (
                  <div className="flex gap-1">
                    <button onClick={saveSectorBounds} disabled={savingSectors} className="text-app-unit text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-900/30 border border-emerald-800/50 disabled:opacity-50">{savingSectors ? "..." : "Save"}</button>
                    <button onClick={() => setEditingSectors(false)} className="text-app-unit text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input">Cancel</button>
                  </div>
                ))}
              </div>
              {sectorBounds ? (
                editingSectors ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                      <span className="text-app-label text-app-text-muted w-16">S1 End</span>
                      <input type="number" step="0.1" min="1" max={editS2 - 1} value={editS1.toFixed(1)} onChange={(e) => setEditS1(Number(e.target.value))} className="w-16 text-app-label font-mono bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                      <span className="text-app-label text-app-text-dim">%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-app-label text-app-text-muted w-16">S2 End</span>
                      <input type="number" step="0.1" min={editS1 + 1} max="99" value={editS2.toFixed(1)} onChange={(e) => setEditS2(Number(e.target.value))} className="w-16 text-app-label font-mono bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                      <span className="text-app-label text-app-text-dim">%</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="w-2 h-2 rounded-full bg-yellow-500" />
                      <span className="text-app-label text-app-text-muted w-16">S3 End</span>
                      <span className="text-app-label font-mono text-app-text-secondary">100.0</span>
                      <span className="text-app-label text-app-text-dim">% (finish)</span>
                    </div>
                    <div className="flex h-2 rounded overflow-hidden mt-1">
                      <div className="bg-red-500/60" style={{ width: `${editS1}%` }} />
                      <div className="bg-blue-500/60" style={{ width: `${editS2 - editS1}%` }} />
                      <div className="bg-yellow-500/60" style={{ width: `${100 - editS2}%` }} />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {[
                      { name: "S1", color: "bg-red-500", frac: sectorBounds.s1End },
                      { name: "S2", color: "bg-blue-500", frac: sectorBounds.s2End - sectorBounds.s1End },
                      { name: "S3", color: "bg-yellow-500", frac: 1 - sectorBounds.s2End },
                    ].map((s) => (
                      <div key={s.name} className="flex items-center gap-2 px-2 py-1 rounded bg-app-surface-alt/30">
                        <div className={`w-2 h-2 rounded-full ${s.color}`} />
                        <span className="text-app-label font-mono font-bold text-app-text">{s.name}</span>
                        {track.lengthKm > 0 && (
                          <span className="text-app-label font-mono text-app-text-dim">{(s.frac * track.lengthKm).toFixed(2)} km</span>
                        )}
                        <span className="text-app-label font-mono text-app-text-secondary ml-auto">{(s.frac * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                    <div className="flex h-2 rounded overflow-hidden mt-1">
                      <div className="bg-red-500/60" style={{ width: `${sectorBounds.s1End * 100}%` }} />
                      <div className="bg-blue-500/60" style={{ width: `${(sectorBounds.s2End - sectorBounds.s1End) * 100}%` }} />
                      <div className="bg-yellow-500/60" style={{ width: `${(1 - sectorBounds.s2End) * 100}%` }} />
                    </div>
                  </div>
                )
              ) : (
                <div className="text-app-label text-app-text-dim">No sector data available</div>
              )}
            </div>
          </div>
        </div>
      ) : (
      <div className="flex flex-col gap-4 h-[calc(100vh-160px)] overflow-hidden">
        <div className="flex flex-col gap-4 min-h-0 overflow-hidden flex-1">
          {/* Track map */}
          <div className="shrink-0 flex gap-3" style={{ height: activeTab === "guide" && isF125 ? 160 : 320 }}>
          {/* F1 leaderboard left of map on laps tab */}
          {isF125 && activeTab === "laps" && (
            <div className="w-[420px] shrink-0 overflow-hidden flex flex-col bg-app-surface/50 border border-app-border rounded-lg p-3">
              <F125Leaderboard trackOrdinal={track.ordinal} />
            </div>
          )}
          <div className="bg-app-bg rounded-lg border border-app-border relative flex-1 min-w-0">
            {track.hasOutline ? (
              <canvas
                ref={canvasRef}
                className="w-full h-full cursor-grab active:cursor-grabbing"
                onMouseDown={(e) => {
                  dragging.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanZ: pan.z };
                }}
                onMouseMove={(e) => {
                  if (!dragging.current) return;
                  const dx = e.clientX - dragging.current.startX;
                  const dy = e.clientY - dragging.current.startY;
                  setPan({ x: dragging.current.startPanX + dx, z: dragging.current.startPanZ + dy });
                }}
                onMouseUp={() => { dragging.current = null; }}
                onMouseLeave={() => { dragging.current = null; }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">
                No outline available
              </div>
            )}
            <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
              <button
                onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
                className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >+</button>
              <button
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
                className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >-</button>
              {zoom !== 1 && (
                <button
                  onClick={() => { setZoom(1); setPan({ x: 0, z: 0 }); }}
                  className="px-1.5 py-1 text-[9px] font-mono bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded"
                >{zoom % 1 === 0 ? `${zoom}x` : `${zoom.toFixed(2)}x`}</button>
              )}
              {(sectorBounds || displaySectors) && (
                <>
                  <div className="h-px" />
                  <button
                    onClick={() => setMapDisplayMode((m) => m === "segments" ? "sectors" : "segments")}
                    className={`px-1.5 py-1 text-[9px] font-mono rounded border transition-colors ${
                      mapDisplayMode === "sectors"
                        ? "bg-amber-900/50 border-amber-700 text-amber-400"
                        : "bg-app-surface-alt/80 border-app-border-input text-app-text-secondary hover:text-app-text"
                    }`}
                    title={mapDisplayMode === "sectors" ? "Show segments" : "Show sectors"}
                  >
                    {mapDisplayMode === "sectors" ? "Sectors" : "Segments"}
                  </button>
                </>
              )}
            </div>
            {/* Track info overlay — bottom left */}
            <div className="absolute bottom-2 left-2 flex items-center gap-2.5 text-[10px] font-mono text-app-text-dim bg-app-surface/70 backdrop-blur-sm rounded px-2 py-1 pointer-events-none">
              {track.lengthKm > 0 && <span>{track.lengthKm} km</span>}
              {corners.length > 0 && <><span className="text-app-text-dim/40">·</span><span>{corners.length} corners</span></>}
              {straights.length > 0 && <><span className="text-app-text-dim/40">·</span><span>{straights.length} straights</span></>}
              {track.createdAt && <><span className="text-app-text-dim/40">·</span><span>{new Date(track.createdAt).toLocaleDateString()}</span></>}
            </div>
          </div>

          </div>

          {/* Tab content */}
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Setups tab — no outer scroll, component handles its own */}
            {activeTab === "setups" && (
              <div className="flex-1 min-h-0">
                {isF125 && <F125SetupsWithGuide trackOrdinal={track.ordinal} trackName={track.name} />}
                {isAcc && <AccTrackSetups trackOrdinal={track.ordinal} />}
              </div>
            )}

            {activeTab === "guide" && isAcc && (
              <div className="flex-1 min-h-0">
                <AccTrackGuide trackOrdinal={track.ordinal} trackName={track.name} />
              </div>
            )}
            {activeTab === "guide" && isF125 && (
              <div className="flex-1 min-h-0 p-2">
                <F125TrackGuide trackOrdinal={track.ordinal} />
              </div>
            )}

            <div className={`flex-1 min-h-0 ${activeTab === "laps" ? "overflow-hidden" : "overflow-auto"} ${activeTab === "setups" || activeTab === "guide" ? "hidden" : ""}`}>

              {/* Tunes tab (Forza) */}
              {activeTab === "tunes" && (
                <TrackTunes trackName={track.name} trackVariant={track.variant} />
              )}

              {/* Laps tab */}
              {activeTab === "laps" && (
                <div className="flex flex-col gap-3 h-full overflow-hidden">
                  {/* Own laps */}
                  <div className="flex flex-col gap-3 h-full overflow-hidden">
                  {trackLaps.length === 0 ? (
                    <div className="text-app-subtext text-app-text-dim py-4 text-center">No laps recorded for this track</div>
                  ) : (
                    <>
                      {/* Car filter + selection actions */}
                      <div className="flex items-center gap-3">
                        <div className="text-app-label text-app-text-muted uppercase tracking-wider">Laps ({filteredLaps.length})</div>
                        {/* Division filter — Forza only */}
                        {hasForzaTunes && uniqueDivisions.length > 1 && (
                          <div className="flex items-center gap-1">
                            <select
                              value={selectedDivision ?? ""}
                              onChange={e => setSelectedDivision(e.target.value || null)}
                              className="text-app-unit px-2 py-0.5 rounded border border-app-border-input text-app-text-secondary bg-app-surface hover:text-app-text focus:outline-none"
                            >
                              <option value="">All divisions</option>
                              {uniqueDivisions.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                            {selectedDivision && (
                              <button onClick={() => setSelectedDivision(null)} className="text-app-unit text-app-text-dim hover:text-app-text px-1 py-0.5">✕</button>
                            )}
                          </div>
                        )}
                        <div className="relative" ref={carDropdownRef}>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => { setCarDropdownOpen(o => !o); setCarSearch(""); }}
                              className="text-app-unit px-2 py-0.5 rounded border border-app-border-input text-app-text-secondary hover:text-app-text flex items-center gap-1.5"
                            >
                              {selectedCars.size === 0 ? "All cars" : `${selectedCars.size} car${selectedCars.size > 1 ? "s" : ""}`}
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                            </button>
                            {selectedCars.size > 0 && (
                              <button onClick={() => { setSelectedCars(new Set()); setSelectedLaps(new Set()); }} className="text-app-unit text-app-text-dim hover:text-app-text px-1 py-0.5">✕</button>
                            )}
                          </div>
                          {carDropdownOpen && (
                            <div className="absolute left-0 top-full mt-1 w-64 bg-app-surface-alt border border-app-border-input rounded-lg shadow-lg z-50">
                              <div className="p-1.5 border-b border-app-border-input">
                                <input
                                  autoFocus
                                  type="text"
                                  value={carSearch}
                                  onChange={e => setCarSearch(e.target.value)}
                                  placeholder="Search cars..."
                                  className="w-full bg-app-surface border border-app-border-input rounded px-2 py-1 text-app-label text-app-text placeholder:text-app-text-dim focus:outline-none"
                                />
                              </div>
                              <div className="max-h-48 overflow-y-auto">
                                {uniqueCars
                                  .filter(c => c.carName.toLowerCase().includes(carSearch.toLowerCase()))
                                  .map(car => {
                                    const active = selectedCars.has(car.carOrdinal);
                                    return (
                                      <button
                                        key={car.carOrdinal}
                                        onClick={() => toggleCar(car.carOrdinal)}
                                        className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-app-label transition-colors hover:bg-app-surface ${active ? "text-app-text" : "text-app-text-secondary"}`}
                                      >
                                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${active ? "bg-app-accent border-app-accent" : "border-app-border-input"}`}>
                                          {active && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                                        </span>
                                        {!isF125 && <span className={`font-bold font-mono text-[10px] flex-shrink-0 ${classTextColors[car.carClass] ?? "text-app-text-secondary"}`}>{car.carClass}</span>}
                                        <span className="truncate">{car.carName}</span>
                                      </button>
                                    );
                                  })}
                                {uniqueCars.filter(c => c.carName.toLowerCase().includes(carSearch.toLowerCase())).length === 0 && (
                                  <div className="px-3 py-2 text-app-label text-app-text-dim">No results</div>
                                )}
                              </div>
                            </div>
                          )}

                        </div>
                        {/* Selection actions — inline in header row */}
                        {selectedLaps.size > 0 && (
                          <div className="flex items-center gap-2 ml-auto">
                            <span className="text-app-unit text-app-text-dim">{selectedLaps.size} selected</span>
                            {selectedLaps.size === 2 && (() => {
                              const [lapA, lapB] = Array.from(selectedLaps);
                              return (
                                <button
                                  onClick={() => navTo({ to: "/fm23/compare", search: { track: track.ordinal, lapA, lapB, carA: trackLaps.find((l) => l.lapId === lapA)?.carOrdinal, carB: trackLaps.find((l) => l.lapId === lapB)?.carOrdinal } })}
                                  className="text-app-unit px-2 py-0.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium"
                                >Compare</button>
                              );
                            })()}
                            {!confirmDelete ? (
                              <button onClick={() => setConfirmDelete(true)} className="text-app-unit px-2 py-0.5 rounded bg-red-600/80 hover:bg-red-600 text-white font-medium">
                                Delete ({selectedLaps.size})
                              </button>
                            ) : (
                              <div className="flex items-center gap-1">
                                <span className="text-app-unit text-red-400">Confirm?</span>
                                <button onClick={handleBulkDelete} disabled={deleting} className="text-app-unit px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50">{deleting ? "..." : "Yes"}</button>
                                <button onClick={() => setConfirmDelete(false)} className="text-app-unit px-2 py-0.5 rounded bg-app-surface-alt text-app-text-secondary hover:text-app-text">Cancel</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Lap stats sidebar + table */}
                      <div className="flex gap-3 flex-1 min-h-0 overflow-hidden">
                      {/* LapStatsPanel */}
                      <LapStatsPanel laps={filteredLaps.filter(l => l.isValid !== false)} showSessionFilter={isF125} />
                      {/* Lap table */}
                      <div className="flex-1 min-w-0 overflow-y-auto bg-app-surface/50 border border-app-border rounded-lg">
                        <Table>
                          <THead>
                            <TH className="w-8 px-3">
                              <input type="checkbox" checked={selectedLaps.size === filteredLaps.length && filteredLaps.length > 0} onChange={toggleAllLaps} className="accent-cyan-400" />
                            </TH>
                            <TH>Car</TH>
                            {!isF125 && <TH>Class</TH>}
                            {hasSessionTypes && <TH>Type</TH>}
                            <TH className="cursor-pointer hover:text-app-text select-none" onClick={() => handleSort("lap")}>
                              Lap # {sortBy === "lap" ? (sortAsc ? "▲" : "▼") : ""}
                            </TH>
                            <TH className="cursor-pointer hover:text-app-text select-none text-right" onClick={() => handleSort("time")}>
                              Time {sortBy === "time" ? (sortAsc ? "▲" : "▼") : ""}
                            </TH>
                            {hasSectorData && <TH className="font-mono text-app-text-dim">S1</TH>}
                            {hasSectorData && <TH className="font-mono text-app-text-dim">S2</TH>}
                            {hasSectorData && <TH className="font-mono text-app-text-dim">S3</TH>}
                            <TH className="cursor-pointer hover:text-app-text select-none" onClick={() => handleSort("date")}>
                              Date {sortBy === "date" ? (sortAsc ? "▲" : "▼") : ""}
                            </TH>
                            <TH>Notes</TH>
                          </THead>
                          <TBody>
                            {(() => {
                              const validLaps = filteredLaps.filter(l => l.isValid !== false);
                              const fastestTime = validLaps.length > 0 ? Math.min(...validLaps.map(l => l.lapTime)) : null;
                              return filteredLaps.map((lap) => {
                              const isFastest = fastestTime !== null && lap.lapTime === fastestTime && lap.isValid !== false;
                              return (
                              <TRow key={lap.lapId} className={selectedLaps.has(lap.lapId) ? "bg-cyan-500/5" : ""}>
                                <TD className="px-3">
                                  <input type="checkbox" checked={selectedLaps.has(lap.lapId)} onChange={() => toggleLapSelect(lap.lapId)} className="accent-cyan-400" />
                                </TD>
                                <TD className="truncate max-w-[200px]">{lap.carName}</TD>
                                {!isF125 && (
                                  <TD>
                                    <span className={`font-bold font-mono ${classTextColors[lap.carClass] ?? "text-app-text-secondary"}`}>{lap.carClass}</span>
                                    <span className="text-app-text-secondary ml-1">PI {lap.pi}</span>
                                  </TD>
                                )}
                                {hasSessionTypes && (
                                  <TD>
                                    {lap.sessionId != null && (sessionLapCounts.get(lap.sessionId) ?? 0) > 1
                                      ? <span className="text-[10px] text-emerald-400 font-medium">Race</span>
                                      : <span className="text-[10px] text-amber-400 font-medium">Quali</span>
                                    }
                                  </TD>
                                )}
                                <TD className="font-mono text-app-text-secondary">{lap.lapNumber}</TD>
                                <TD className="text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <span className={`font-mono tabular-nums ${isFastest ? "text-purple-400 font-bold" : ""}`}>{formatLapTime(lap.lapTime)}</span>
                                    {lap.isValid === false
                                      ? <span className="group/inv relative text-[10px] text-red-400 cursor-default">✕<span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover/inv:block w-max max-w-[200px] bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[10px] text-app-text-secondary z-50 pointer-events-none leading-relaxed">{lap.invalidReason ?? "Invalid lap"}</span></span>
                                      : <span className="text-[10px] text-emerald-500/60">✓</span>
                                    }
                                    <Button
                                      variant="app-outline"
                                      size="app-sm"
                                      className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70"
                                      onClick={() => navTo({ to: "/fm23/analyse", search: { track: track.ordinal, car: lap.carOrdinal, lap: lap.lapId } })}
                                    >
                                      Analyse
                                    </Button>
                                  </div>
                                </TD>
                                {hasSectorData && <TD className="font-mono text-[11px] tabular-nums text-app-text-secondary">{lap.s1Time != null ? formatLapTime(lap.s1Time) : "—"}</TD>}
                                {hasSectorData && <TD className="font-mono text-[11px] tabular-nums text-app-text-secondary">{lap.s2Time != null ? formatLapTime(lap.s2Time) : "—"}</TD>}
                                {hasSectorData && <TD className="font-mono text-[11px] tabular-nums text-app-text-secondary">{lap.s3Time != null ? formatLapTime(lap.s3Time) : "—"}</TD>}
                                <TD className="text-app-text-secondary whitespace-nowrap font-mono">
                                  {lap.createdAt ? `${new Date(lap.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${new Date(lap.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : "—"}
                                </TD>
                                <TD className="text-app-text-secondary max-w-[200px] truncate" title={lap.notes ?? undefined}>
                                  {lap.notes ?? ""}
                                </TD>
                              </TRow>
                            );});})()}
                            {filteredLaps.length === 0 && (
                              <tr><td colSpan={6} className="px-3 py-4 text-center text-sm text-app-text-dim">No laps match the selected filters</td></tr>
                            )}
                          </TBody>
                        </Table>
                      </div>
                      </div>{/* end stats+table flex */}

                    </>
                  )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

      </div>
      )}
    </div>
  );
}
