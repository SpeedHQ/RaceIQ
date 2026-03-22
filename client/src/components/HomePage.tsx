import { useMemo, useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useTelemetryStore } from "../stores/telemetry";
import { useLaps, useStatus } from "../hooks/queries";
import { useActiveProfileId } from "../hooks/useProfiles";
import { formatLapTime } from "./LiveTelemetry";
import { api } from "../lib/api";
import type { LapMeta } from "@shared/types";
import { CAR_CLASS_NAMES } from "@shared/types";

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

function RecentLapRow({ lap, carName, trackName }: { lap: LapMeta; carName: string; trackName: string }) {
  const best = lap.isValid;
  return (
    <Link
      to="/analyse"
      search={{ track: lap.trackOrdinal ?? undefined, car: lap.carOrdinal ?? undefined, lap: lap.id }}
      className="flex items-center gap-3 px-3 py-2 hover:bg-app-surface-alt/30 rounded transition-colors"
    >
      <span className="text-xs font-mono text-app-text-muted w-6">L{lap.lapNumber}</span>
      <span className="text-lg font-mono font-bold text-app-text tabular-nums flex-1">
        {formatLapTime(lap.lapTime)}
      </span>
      <span className="text-xs text-app-text-secondary truncate max-w-[140px]">{trackName || "—"}</span>
      <span className="text-xs text-app-text-dim truncate max-w-[120px]">{carName || "—"}</span>
      {lap.pi && (
        <span className="text-[10px] font-mono font-semibold px-1.5 py-px rounded bg-app-surface-alt text-app-accent">
          {CAR_CLASS_NAMES[lap.carOrdinal ? 4 : 0] ?? ""}{lap.pi}
        </span>
      )}
      <span className={`text-xs ${best ? "text-emerald-400" : "text-red-400"}`}>
        {best ? "\u2713" : "\u2717"}
      </span>
    </Link>
  );
}

export function HomePage() {
  const { data: activeProfileId } = useActiveProfileId();
  const { data: allLaps = [] } = useLaps(activeProfileId);
  const { data: status } = useStatus();
  const connected = useTelemetryStore((s) => s.connected);
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);

  // Resolve car/track names for recent laps
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});

  const recentLaps = useMemo(() =>
    [...allLaps].filter((l) => l.lapTime > 0).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10),
    [allLaps]
  );

  const validLaps = allLaps.filter((l) => l.isValid && l.lapTime > 0);
  const bestLap = validLaps.length > 0 ? validLaps.reduce((best, l) => l.lapTime < best.lapTime ? l : best) : null;
  const totalLaps = allLaps.length;
  const uniqueTracks = new Set(allLaps.map((l) => l.trackOrdinal).filter(Boolean)).size;
  const uniqueCars = new Set(allLaps.map((l) => l.carOrdinal).filter(Boolean)).size;

  // Average lap time (valid laps only)
  const avgLapTime = validLaps.length > 0
    ? validLaps.reduce((s, l) => s + l.lapTime, 0) / validLaps.length
    : 0;

  // Session info
  const sessionTrack = (status as any)?.currentSession?.trackOrdinal;
  const sessionCar = (status as any)?.currentSession?.carOrdinal;
  const isLive = connected && packetsPerSec > 0;

  // Fetch names
  useEffect(() => {
    const carOrds = [...new Set(recentLaps.map((l) => l.carOrdinal).filter((o): o is number => o != null))];
    const trackOrds = [...new Set(recentLaps.map((l) => l.trackOrdinal).filter((o): o is number => o != null))];
    for (const ord of carOrds) {
      if (carNames[ord]) continue;
      api.getCarName(ord).then((name) => setCarNames((prev) => ({ ...prev, [ord]: name }))).catch(() => {});
    }
    for (const ord of trackOrds) {
      if (trackNames[ord]) continue;
      api.getTrackName(ord).then((name) => setTrackNames((prev) => ({ ...prev, [ord]: name }))).catch(() => {});
    }
  }, [recentLaps]);

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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Laps" value={`${totalLaps}`} />
        <StatCard
          label="Best Lap"
          value={bestLap ? formatLapTime(bestLap.lapTime) : "—"}
          color="text-purple-400"
        />
        <StatCard label="Tracks" value={`${uniqueTracks}`} />
        <StatCard label="Cars" value={`${uniqueCars}`} />
      </div>

      {/* Additional stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard
          label="Valid Laps"
          value={`${validLaps.length}`}
          sub={totalLaps > 0 ? `${((validLaps.length / totalLaps) * 100).toFixed(0)}% clean` : undefined}
          color="text-emerald-400"
        />
        <StatCard
          label="Avg Lap Time"
          value={avgLapTime > 0 ? formatLapTime(avgLapTime) : "—"}
          color="text-app-text-secondary"
        />
        <StatCard
          label="Session"
          value={isLive ? "Active" : "Idle"}
          sub={isLive && sessionTrack ? `Track #${sessionTrack}` : undefined}
          color={isLive ? "text-emerald-400" : "text-app-text-dim"}
        />
      </div>

      {/* Recent laps */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Recent Laps</h2>
          <Link to="/tracks" className="text-xs text-app-accent hover:text-app-accent/80">
            View all tracks
          </Link>
        </div>
        <div className="bg-app-surface-alt/20 rounded-lg divide-y divide-app-border/50">
          {recentLaps.length > 0 ? (
            recentLaps.map((lap) => (
              <RecentLapRow
                key={lap.id}
                lap={lap}
                carName={lap.carOrdinal != null ? carNames[lap.carOrdinal] ?? "" : ""}
                trackName={lap.trackOrdinal != null ? trackNames[lap.trackOrdinal] ?? "" : ""}
              />
            ))
          ) : (
            <div className="p-6 text-center text-app-text-dim">
              No laps recorded yet. Start driving in Forza to see data here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
