import { useMemo, useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTelemetryStore } from "../stores/telemetry";
import { useLaps } from "../hooks/queries";
import { useActiveProfileId } from "../hooks/useProfiles";
import { formatLapTime } from "./LiveTelemetry";
import { client } from "../lib/rpc";
import type { LapMeta } from "@shared/types";
import { useGameId, getGameRoute } from "../stores/game";
import { tryGetGame } from "@shared/games/registry";
import { PiBadge, PI_COLORS, piClass } from "./forza/PiBadge";
import { Button } from "./ui/button";

type GameDetectionInfo = {
  installed: boolean;
  extracted: boolean;
  extractionStatus: string;
  trackCount: number;
};

type ExtractionStatusInfo = {
  status: string;
  installed: boolean;
  extracted: number;
  failed: number;
  total: number;
  current: string;
  error?: string;
};

function ExtractionBanner({ gameId }: { gameId: string }) {
  const queryClient = useQueryClient();
  const [pollEnabled, setPollEnabled] = useState(false);

  const { data: detection } = useQuery<Record<string, GameDetectionInfo>>({
    queryKey: ["games-detection"],
    queryFn: () => fetch("/api/games/detection").then((r) => r.json()),
  });

  const gameDetection = detection?.[gameId];

  const { data: extractionStatus } = useQuery<ExtractionStatusInfo>({
    queryKey: ["extraction-status", gameId],
    queryFn: () =>
      fetch(gameId === "f1-2025" ? "/api/extraction/f1/status" : "/api/extraction/status").then((r) => r.json()),
    enabled: pollEnabled,
    refetchInterval: pollEnabled ? 500 : false,
  });

  const isRunning = extractionStatus?.status === "running" || (pollEnabled && extractionStatus?.status === undefined);
  const isDone = gameDetection?.extracted === true;
  const isError = extractionStatus?.status === "error";
  const progress = extractionStatus && extractionStatus.total > 0
    ? Math.round((extractionStatus.extracted + extractionStatus.failed) / extractionStatus.total * 100)
    : 0;

  useEffect(() => {
    if (extractionStatus?.status === "done") {
      setPollEnabled(false);
      queryClient.invalidateQueries({ queryKey: ["games-detection"] });
    }
  }, [extractionStatus?.status, queryClient]);

  if (!gameDetection || isDone) return null;

  const handleExtract = async () => {
    setPollEnabled(true);
    await fetch(gameId === "f1-2025" ? "/api/extraction/f1/run" : "/api/extraction/run", { method: "POST" });
  };

  const accent = gameId === "f1-2025"
    ? { border: "border-red-500/30", bg: "bg-red-500/8", text: "text-red-400", bar: "bg-red-500" }
    : { border: "border-cyan-500/30", bg: "bg-cyan-500/8", text: "text-cyan-400", bar: "bg-cyan-500" };

  const gameName = gameId === "f1-2025" ? "F1 25" : "Forza Motorsport 2023";

  return (
    <div className={`relative rounded-lg border ${accent.border} ${accent.bg} overflow-hidden`}>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-start gap-3 min-w-0">
          <svg className={`w-4 h-4 mt-0.5 shrink-0 ${accent.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-app-text leading-tight">Track data not extracted</p>
            {isError ? (
              <p className="text-xs text-red-400 mt-0.5">{extractionStatus?.error ?? "Extraction failed"}</p>
            ) : isRunning ? (
              <p className="text-xs text-app-text-muted mt-0.5">
                {extractionStatus?.current ? `Extracting ${extractionStatus.current}\u2026` : "Starting extraction\u2026"}
                {extractionStatus && extractionStatus.total > 0 && (
                  <span className="ml-1 tabular-nums">({extractionStatus.extracted}/{extractionStatus.total})</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-app-text-muted mt-0.5">
                Extract track outlines from your {gameName} installation for accurate track maps.
                {gameDetection.installed
                  ? <span className={`ml-1 ${accent.text}`}>Game installation detected.</span>
                  : <span className="ml-1 text-app-text-dim">Game not found — you can still extract if installed elsewhere.</span>
                }
              </p>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <Button size="sm" variant={isError ? "destructive" : "default"} disabled={isRunning} onClick={handleExtract} className="text-xs">
            {isRunning ? "Extracting\u2026" : isError ? "Retry" : "Extract Track Data"}
          </Button>
        </div>
      </div>
      {isRunning && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-app-border">
          <div className={`h-full transition-all duration-300 ${accent.bar}`} style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

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

function RecentLapsTable({ laps, carNames, trackNames, gameId }: {
  laps: LapMeta[];
  carNames: Record<number, string>;
  trackNames: Record<number, string>;
  gameId: string | null;
}) {
  const showGame = !gameId; // show game column on global homepage
  const showPi = !gameId || gameId === "fm-2023"; // PI is Forza-only
  if (laps.length === 0) {
    return (
      <div className="p-6 text-center text-app-text-dim">
        No laps recorded yet. Start driving to see data here.
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[10px] text-app-text-muted uppercase tracking-wider border-b border-app-border">
          {showGame && <th className="text-left px-3 py-2">Game</th>}
          <th className="text-left px-3 py-2">Track</th>
          <th className="text-left px-3 py-2">Car</th>
          {showPi && <th className="text-center px-3 py-2">PI</th>}
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
              onClick={() => {
                window.location.href = `${getGameRoute(lap.gameId ?? "fm-2023")}/analyse?track=${lap.trackOrdinal ?? ""}&car=${lap.carOrdinal ?? ""}&lap=${lap.id}`;
              }}
            >
              {showGame && <td className="px-3 py-2">
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${lap.gameId === "f1-2025" ? "bg-red-500/20 text-red-400" : lap.gameId === "acc" ? "bg-orange-500/20 text-orange-400" : "bg-app-accent/20 text-app-accent"}`}>
                  {lap.gameId === "f1-2025" ? "F1" : lap.gameId === "acc" ? "ACC" : "FM"}
                </span>
              </td>}
              <td className="px-3 py-2 text-app-text-secondary truncate max-w-[160px]" title={track}>{track || "—"}</td>
              <td className="px-3 py-2 text-app-text-secondary truncate max-w-[140px]" title={car}>{car || "—"}</td>
              {showPi && <td className="px-3 py-2 text-center">{lap.pi != null && lap.pi > 0 && (
                <span className="inline-flex items-center gap-1">
                  <PiBadge showNumber={false} pi={lap.pi} />
                  <span className={`text-[10px] font-semibold ${PI_COLORS[piClass(lap.pi)]?.split(" ")[1] ?? "text-app-text-muted"}`}>{lap.pi}</span>
                </span>
              )}</td>}
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
  const gameId = useGameId();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const { data: activeProfileId } = useActiveProfileId();
  const { data: allLaps = [] } = useLaps(activeProfileId);
  const connected = useTelemetryStore((s) => s.connected);
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const serverStatus = useTelemetryStore((s) => s.serverStatus);
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => client.api.stats.$get({ query: {} }).then((r) => r.json()),
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

  // Per-game stats
  const gameStats = useMemo(() => {
    const fm = allLaps.filter((l) => l.gameId === "fm-2023");
    const f1 = allLaps.filter((l) => l.gameId === "f1-2025");
    const acc = allLaps.filter((l) => l.gameId === "acc");
    return {
      fm: { laps: fm.length, tracks: new Set(fm.map((l) => l.trackOrdinal).filter(Boolean)).size },
      f1: { laps: f1.length, tracks: new Set(f1.map((l) => l.trackOrdinal).filter(Boolean)).size },
      acc: { laps: acc.length, tracks: new Set(acc.map((l) => l.trackOrdinal).filter(Boolean)).size },
    };
  }, [allLaps]);

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
  const sessionTrack = serverStatus?.currentSession?.trackOrdinal;
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
      // Find the gameId from a lap that has this ordinal
      const lapForCar = recentLaps.find((l) => l.carOrdinal === ord);
      client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: (lapForCar?.gameId ?? gameId)! } }).then((r) => r.ok ? r.text() : "").then((name) => setCarNames((prev) => ({ ...prev, [ord]: name }))).catch(() => {});
    }
    for (const ord of trackOrds) {
      if (trackNames[ord]) continue;
      const lapForTrack = recentLaps.find((l) => l.trackOrdinal === ord);
      client.api["track-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: (lapForTrack?.gameId ?? gameId)! } }).then((r) => r.ok ? r.text() : "").then((name) => setTrackNames((prev) => ({ ...prev, [ord]: name }))).catch(() => {});
    }
  }, [recentLaps, periodStats, gameId]);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {(gameId === "fm-2023" || gameId === "f1-2025") && <ExtractionBanner gameId={gameId} />}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-app-text">{gameAdapter ? gameAdapter.displayName : "RaceIQ"}</h1>
          <p className="text-sm text-app-text-muted mt-0.5">Dashboard overview</p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isLive ? "bg-emerald-400 animate-pulse" : "bg-app-text-dim"}`} />
          <span className="text-sm text-app-text-secondary">{isLive ? `Live — ${packetsPerSec} pkt/s` : "Not connected"}</span>
        </div>
      </div>

      {/* Game cards — only on global homepage */}
      {!gameId && <div className="flex gap-3">
        <Link
          to="/fm23"
          className="group flex-1 relative overflow-hidden rounded-lg border border-cyan-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-cyan-500/35 hover:shadow-[0_8px_32px_rgba(0,212,255,0.1)]"
          style={{ background: "linear-gradient(135deg, #060a14 0%, #0a1628 40%, #0d2040 100%)" }}
        >
          {/* Accent glow */}
          <div className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" style={{ background: "radial-gradient(circle, rgba(0,212,255,0.15) 0%, transparent 70%)" }} />
          {/* Bottom accent bar */}
          <div className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" style={{ background: "linear-gradient(90deg, #00d4ff 0%, transparent 70%)" }} />
          {/* Speed lines */}
          <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
            <div className="absolute top-[18%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #00d4ff 30%, transparent 100%)" }} />
            <div className="absolute top-[45%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #00d4ff 50%, transparent 100%)" }} />
            <div className="absolute top-[72%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #00d4ff 60%, transparent 100%)" }} />
          </div>
          {/* Icon + Name */}
          <div className="relative flex items-center gap-2.5 mb-3.5">
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-cyan-500/8 border border-cyan-500/10">
              <img src="/forza-logo.svg" alt="" className="w-5 h-5" style={{ filter: "brightness(0) saturate(100%) invert(72%) sepia(98%) saturate(1234%) hue-rotate(152deg) brightness(101%) contrast(101%)" }} />
            </div>
            <span className="text-sm font-bold text-white/90">Forza Motorsport</span>
          </div>
          {/* Stats */}
          <div className="relative flex gap-5">
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/22 mb-0.5">Laps</div>
              <div className="text-lg font-extrabold font-mono leading-none text-cyan-400">{gameStats.fm.laps}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/22 mb-0.5">Tracks</div>
              <div className="text-lg font-extrabold font-mono leading-none text-white/50">{gameStats.fm.tracks}</div>
            </div>
          </div>
        </Link>
        <Link
          to="/f125"
          className="group flex-1 relative overflow-hidden rounded-lg border border-red-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-red-500/35 hover:shadow-[0_8px_32px_rgba(255,26,26,0.1)]"
          style={{ background: "linear-gradient(135deg, #0e0606 0%, #1a0808 40%, #2d0a0a 100%)" }}
        >
          {/* Accent glow */}
          <div className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" style={{ background: "radial-gradient(circle, rgba(255,26,26,0.15) 0%, transparent 70%)" }} />
          {/* Bottom accent bar */}
          <div className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" style={{ background: "linear-gradient(90deg, #ff1a1a 0%, transparent 70%)" }} />
          {/* Speed lines */}
          <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
            <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff1a1a 30%, transparent 100%)" }} />
            <div className="absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff1a1a 50%, transparent 100%)" }} />
            <div className="absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #ff1a1a 60%, transparent 100%)" }} />
          </div>
          {/* Icon + Name */}
          <div className="relative flex items-center gap-2.5 mb-3.5">
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-red-500/8 border border-red-500/10">
              <img src="/f1-logo.svg" alt="" className="w-5 h-5" style={{ filter: "brightness(0) saturate(100%) invert(28%) sepia(67%) saturate(5839%) hue-rotate(350deg) brightness(100%) contrast(107%)" }} />
            </div>
            <span className="text-sm font-bold text-white/90">F1 2025</span>
          </div>
          {/* Stats */}
          <div className="relative flex gap-5">
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/22 mb-0.5">Laps</div>
              <div className="text-lg font-extrabold font-mono leading-none text-red-500">{gameStats.f1.laps}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/22 mb-0.5">Tracks</div>
              <div className="text-lg font-extrabold font-mono leading-none text-white/50">{gameStats.f1.tracks}</div>
            </div>
          </div>
        </Link>
        <Link
          to="/acc"
          className="group flex-1 relative overflow-hidden rounded-lg border border-orange-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-orange-500/35 hover:shadow-[0_8px_32px_rgba(255,140,0,0.1)]"
          style={{ background: "linear-gradient(135deg, #0e0a04 0%, #1a1008 40%, #2d1a0a 100%)" }}
        >
          {/* Accent glow */}
          <div className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" style={{ background: "radial-gradient(circle, rgba(255,140,0,0.15) 0%, transparent 70%)" }} />
          {/* Bottom accent bar */}
          <div className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" style={{ background: "linear-gradient(90deg, #ff8c00 0%, transparent 70%)" }} />
          {/* Speed lines */}
          <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
            <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff8c00 30%, transparent 100%)" }} />
            <div className="absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff8c00 50%, transparent 100%)" }} />
            <div className="absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #ff8c00 60%, transparent 100%)" }} />
          </div>
          {/* Icon + Name */}
          <div className="relative flex items-center gap-2.5 mb-3.5">
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-orange-500/8 border border-orange-500/10">
              <span className="text-xs font-black text-orange-400">AC</span>
            </div>
            <span className="text-sm font-bold text-white/90">Assetto Corsa Competizione</span>
          </div>
          {/* Stats */}
          <div className="relative flex gap-5">
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/22 mb-0.5">Laps</div>
              <div className="text-lg font-extrabold font-mono leading-none text-orange-400">{gameStats.acc.laps}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/22 mb-0.5">Tracks</div>
              <div className="text-lg font-extrabold font-mono leading-none text-white/50">{gameStats.acc.tracks}</div>
            </div>
          </div>
        </Link>
      </div>}

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
          <Link to={`${getGameRoute(gameId ?? "fm-2023")}/tracks` as any} className="text-xs text-app-accent hover:text-app-accent/80">
            View all tracks
          </Link>
        </div>
        <div className="bg-app-surface-alt/20 rounded-lg overflow-hidden">
          <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} />
        </div>
      </div>
    </div>
  );
}
