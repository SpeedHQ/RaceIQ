import { useMemo, useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTelemetryStore } from "../stores/telemetry";
import { useLaps, useStatus } from "../hooks/queries";
import { useActiveProfileId } from "../hooks/useProfiles";
import { formatLapTime } from "./LiveTelemetry";
import { api } from "../lib/api";
import type { LapMeta } from "@shared/types";
import { PiBadge, PI_COLORS, piClass } from "./PiBadge";

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text"}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-app-text-dim mt-1">{sub}</div>}
    </div>
  );
}

function RecentLapsTable({ laps, carNames, trackNames }: {
  laps: LapMeta[];
  carNames: Record<number, string>;
  trackNames: Record<number, string>;
}) {
  if (laps.length === 0) {
    return (
      <div className="p-6 text-center text-app-text-dim">
        No laps recorded yet. Start driving in Forza to see data here.
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[10px] text-app-text-muted uppercase tracking-wider border-b border-app-border">
          <th className="text-left px-3 py-2">Track</th>
          <th className="text-left px-3 py-2">Car</th>
          <th className="text-center px-3 py-2">PI</th>
          <th className="text-left px-3 py-2">Lap</th>
          <th className="text-left px-3 py-2">Time</th>
          <th className="text-center px-3 py-2">Valid</th>
          <th className="text-right px-3 py-2">When</th>
        </tr>
      </thead>
      <tbody>
        {laps.map((lap) => {
          const track = lap.trackOrdinal != null ? trackNames[lap.trackOrdinal] ?? "" : "";
          const car = lap.carOrdinal != null ? carNames[lap.carOrdinal] ?? "" : "";
          const ago = formatTimeAgo(new Date(lap.createdAt));

          return (
            <tr
              key={lap.id}
              className="border-b border-app-border/30 hover:bg-app-surface-alt/30 cursor-pointer transition-colors"
              onClick={() => window.location.href = `/analyse?track=${lap.trackOrdinal ?? ""}&car=${lap.carOrdinal ?? ""}&lap=${lap.id}`}
            >
              <td className="px-3 py-2 text-app-text-secondary truncate max-w-[160px]" title={track}>{track || "—"}</td>
              <td className="px-3 py-2 text-app-text-secondary truncate max-w-[140px]" title={car}>{car || "—"}</td>
              <td className="px-3 py-2 text-center">{lap.pi != null && lap.pi > 0 && (
                <span className="inline-flex items-center gap-1">
                  <PiBadge showNumber={false} pi={lap.pi} />
                  <span className={`text-[10px] font-semibold ${PI_COLORS[piClass(lap.pi)]?.split(" ")[1] ?? "text-app-text-muted"}`}>{lap.pi}</span>
                </span>
              )}</td>
              <td className="px-3 py-2 font-mono text-app-text-muted">L{lap.lapNumber}</td>
              <td className="px-3 py-2 font-mono font-bold text-app-text tabular-nums">{formatLapTime(lap.lapTime)}</td>
              <td className="px-3 py-2 text-center">
                <span className={lap.isValid ? "text-emerald-400" : "text-red-400"}>
                  {lap.isValid ? "\u2713" : "\u2717"}
                </span>
              </td>
              <td className="px-3 py-2 text-right text-xs text-app-text-dim">{ago}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function formatTimeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return date.toLocaleDateString();
}

export function HomePage() {
  const { data: activeProfileId } = useActiveProfileId();
  const { data: allLaps = [] } = useLaps(activeProfileId);
  const { data: status } = useStatus();
  const connected = useTelemetryStore((s) => s.connected);
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: api.getStats,
  });

  // Resolve car/track names for recent laps
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});

  const recentLaps = useMemo(() =>
    [...allLaps].filter((l) => l.lapTime > 0).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10),
    [allLaps]
  );

  const validLaps = allLaps.filter((l) => l.isValid && l.lapTime > 0);
  const totalLaps = allLaps.length;
  const uniqueTracks = new Set(allLaps.map((l) => l.trackOrdinal).filter(Boolean)).size;
  const uniqueCars = new Set(allLaps.map((l) => l.carOrdinal).filter(Boolean)).size;

  // Period metrics
  const [periodTab, setPeriodTab] = useState<"today" | "week" | "month">("today");

  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  const periodStats = useMemo(() => {
    function computePeriod(laps: LapMeta[]) {
      const valid = laps.filter((l) => l.isValid && l.lapTime > 0);
      const best = valid.length > 0 ? Math.min(...valid.map((l) => l.lapTime)) : 0;
      const avgTime = valid.length > 0 ? valid.reduce((s, l) => s + l.lapTime, 0) / valid.length : 0;
      const totalTime = laps.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);
      const tracks = new Set(laps.map((l) => l.trackOrdinal).filter(Boolean)).size;
      const carCounts = new Map<number, number>();
      for (const l of laps) {
        if (l.carOrdinal) carCounts.set(l.carOrdinal, (carCounts.get(l.carOrdinal) ?? 0) + 1);
      }
      let favCarOrd: number | null = null;
      let favCarCount = 0;
      for (const [ord, count] of carCounts) {
        if (count > favCarCount) { favCarOrd = ord; favCarCount = count; }
      }
      return { laps: laps.length, valid: valid.length, best, avgTime, totalTime, tracks, favCarOrd, favCarCount };
    }

    const todayLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= todayStart);
    const weekLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= weekAgo);
    const monthLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= monthAgo);

    return {
      today: computePeriod(todayLaps),
      week: computePeriod(weekLaps),
      month: computePeriod(monthLaps),
    };
  }, [allLaps]);

  // Session info
  const sessionTrack = (status as any)?.currentSession?.trackOrdinal;
  const isLive = connected && packetsPerSec > 0;

  // Fetch names for recent laps + favourite cars
  useEffect(() => {
    const carOrds = [...new Set([
      ...recentLaps.map((l) => l.carOrdinal),
      periodStats.today.favCarOrd,
      periodStats.week.favCarOrd,
      periodStats.month.favCarOrd,
    ].filter((o): o is number => o != null))];
    const trackOrds = [...new Set(recentLaps.map((l) => l.trackOrdinal).filter((o): o is number => o != null))];
    for (const ord of carOrds) {
      if (carNames[ord]) continue;
      api.getCarName(ord).then((name) => setCarNames((prev) => ({ ...prev, [ord]: name }))).catch(() => {});
    }
    for (const ord of trackOrds) {
      if (trackNames[ord]) continue;
      api.getTrackName(ord).then((name) => setTrackNames((prev) => ({ ...prev, [ord]: name }))).catch(() => {});
    }
  }, [recentLaps, periodStats]);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-app-text">Forza Telemetry</h1>
          <p className="text-sm text-app-text-muted mt-0.5">Dashboard overview</p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isLive ? "bg-emerald-400 animate-pulse" : "bg-app-text-dim"}`} />
          <span className="text-sm text-app-text-secondary">{isLive ? `Live — ${packetsPerSec} pkt/s` : "Not connected"}</span>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-3">
        <Link
          to="/live/driver"
          className="flex-1 bg-app-accent/10 hover:bg-app-accent/20 border border-app-accent/30 rounded-lg p-4 transition-colors"
        >
          <div className="text-sm font-bold text-app-accent">Driver View</div>
          <div className="text-xs text-app-text-muted mt-0.5">Race-focused dashboard</div>
        </Link>
        <Link
          to="/live/pit"
          className="flex-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded-lg p-4 transition-colors"
        >
          <div className="text-sm font-bold text-purple-400">Pit Crew View</div>
          <div className="text-xs text-app-text-muted mt-0.5">Full telemetry diagnostics</div>
        </Link>
        <Link
          to="/compare"
          className="flex-1 bg-app-surface-alt/50 hover:bg-app-surface-alt/80 border border-app-border rounded-lg p-4 transition-colors"
        >
          <div className="text-sm font-bold text-app-text">Compare Laps</div>
          <div className="text-xs text-app-text-muted mt-0.5">Side-by-side analysis</div>
        </Link>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Total Laps" value={`${totalLaps}`} />
        <StatCard label="Tracks" value={`${uniqueTracks}`} />
        <StatCard label="Cars" value={`${uniqueCars}`} />
      </div>

      {/* Additional stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Valid Laps"
          value={`${validLaps.length}`}
          sub={totalLaps > 0 ? `${((validLaps.length / totalLaps) * 100).toFixed(0)}% clean` : undefined}
          color="text-emerald-400"
        />
        <StatCard
          label="Total Distance"
          value={stats?.totalDistanceMeters
            ? `${(stats.totalDistanceMeters / 1000).toFixed(0)} km`
            : "—"}
          sub={stats?.totalDistanceMeters
            ? `${(stats.totalDistanceMeters / 1609.34).toFixed(0)} mi`
            : undefined}
          color="text-cyan-400"
        />
        <StatCard
          label="Session"
          value={isLive ? "Active" : "Idle"}
          sub={isLive && sessionTrack ? `Track #${sessionTrack}` : undefined}
          color={isLive ? "text-emerald-400" : "text-app-text-dim"}
        />
      </div>

      {/* Period stats with tabs */}
      {(() => {
        const data = periodStats[periodTab];
        return (
          <div className="bg-app-surface-alt/20 rounded-lg p-4">
            <div className="flex items-center gap-1 mb-3">
              {([["today", "Today"], ["week", "This Week"], ["month", "This Month"]] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setPeriodTab(key)}
                  className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {data.laps > 0 ? (
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-app-text-muted">Laps</span>
                  <span className="text-sm font-mono font-bold text-app-text">{data.laps} <span className="text-app-text-dim">({data.valid} valid)</span></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-app-text-muted">Best Lap</span>
                  <span className="text-sm font-mono font-bold text-purple-400">{data.best > 0 ? formatLapTime(data.best) : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-app-text-muted">Avg Lap</span>
                  <span className="text-sm font-mono font-bold text-app-text-secondary">{data.avgTime > 0 ? formatLapTime(data.avgTime) : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-app-text-muted">Time Driven</span>
                  <span className="text-sm font-mono font-bold text-app-text">
                    {Math.floor(data.totalTime / 3600)}h {Math.floor((data.totalTime % 3600) / 60)}m
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-app-text-muted">Tracks</span>
                  <span className="text-sm font-mono font-bold text-app-text">{data.tracks}</span>
                </div>
                {data.favCarOrd && (
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-app-text-muted">Favourite Car</span>
                    <span className="text-sm font-bold text-app-text truncate ml-2">
                      {carNames[data.favCarOrd] ?? `#${data.favCarOrd}`}
                      <span className="text-app-text-dim font-normal ml-1">({data.favCarCount} laps)</span>
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-app-text-dim">No laps recorded</div>
            )}
          </div>
        );
      })()}

      {/* Recent laps */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Recent Laps</h2>
          <Link to="/tracks" className="text-xs text-app-accent hover:text-app-accent/80">
            View all tracks
          </Link>
        </div>
        <div className="bg-app-surface-alt/20 rounded-lg overflow-hidden">
          <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} />
        </div>
      </div>
    </div>
  );
}
