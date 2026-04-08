import { useMemo, useState, useEffect, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTelemetryStore } from "../stores/telemetry";
import { useLaps, useSettings } from "../hooks/queries";
import { formatLapTime } from "./LiveTelemetry";
import { client } from "../lib/rpc";
import type { LapMeta } from "@shared/types";
import { useGameId, getGameRoute } from "../stores/game";
import { tryGetGame } from "@shared/games/registry";
import { PiBadge, PI_COLORS, piClass } from "./forza/PiBadge";
import { Table, THead, TBody, TRow, TH, TD } from "./ui/AppTable";


function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="text-[10px] text-app-text/90-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-app-text/90-dim mt-1">{sub}</div>}
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
      <div className="p-6 text-center text-app-text/90-dim">
        No laps recorded yet. Start driving to see data here.
      </div>
    );
  }

  return (
    <Table>
      <THead>
        {showGame && <TH>Game</TH>}
        <TH>Track</TH>
        <TH>Car</TH>
        {showPi && <TH className="text-center">PI</TH>}
        <TH>Lap</TH>
        <TH>Time</TH>
        <TH className="text-center">Valid</TH>
        <TH className="text-right">When</TH>
      </THead>
      <TBody>
        {laps.map((lap) => {
          const track = lap.trackOrdinal != null ? trackNames[lap.trackOrdinal] ?? "" : "";
          const car = lap.carOrdinal != null ? carNames[lap.carOrdinal] ?? "" : "";
          const ago = formatTimeAgo(new Date(lap.createdAt));
          return (
            <TRow key={lap.id} onClick={() => { window.location.href = `${getGameRoute(lap.gameId ?? "fm-2023")}/analyse?track=${lap.trackOrdinal ?? ""}&car=${lap.carOrdinal ?? ""}&lap=${lap.id}`; }}>
              {showGame && <TD>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${lap.gameId === "f1-2025" ? "bg-red-500/20 text-red-400" : lap.gameId === "acc" ? "bg-orange-500/20 text-orange-400" : "bg-app-accent/20 text-app-accent"}`}>
                  {lap.gameId === "f1-2025" ? "F1" : lap.gameId === "acc" ? "ACC" : "FM"}
                </span>
              </TD>}
              <TD className="text-app-text/90 truncate max-w-[160px]" title={track}>{track || "—"}</TD>
              <TD className="text-app-text/90 truncate max-w-[140px]" title={car}>{car || "—"}</TD>
              {showPi && <TD className="text-center">{lap.pi != null && lap.pi > 0 && (
                <span className="inline-flex items-center gap-1">
                  <PiBadge showNumber={false} pi={lap.pi} />
                  <span className={`text-[10px] font-semibold ${PI_COLORS[piClass(lap.pi)]?.split(" ")[1] ?? "text-app-text/90-muted"}`}>{lap.pi}</span>
                </span>
              )}</TD>}
              <TD className="font-mono text-app-text/90">L{lap.lapNumber}</TD>
              <TD className="font-mono font-bold text-app-text/90 tabular-nums">{formatLapTime(lap.lapTime)}</TD>
              <TD className="text-center">
                <span className={lap.isValid ? "text-emerald-400" : "text-red-400"}>
                  {lap.isValid ? "\u2713" : "\u2717"}
                </span>
              </TD>
              <TD className="text-right text-xs text-app-text/90">{ago}</TD>
            </TRow>
          );
        })}
      </TBody>
    </Table>
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
  const { data: allLaps = [] } = useLaps();
  const { displaySettings } = useSettings();
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

  // Per-game stats
  const gameStats = useMemo(() => {
    const fm = allLaps.filter((l) => l.gameId === "fm-2023");
    const f1 = allLaps.filter((l) => l.gameId === "f1-2025");
    const acc = allLaps.filter((l) => l.gameId === "acc");
    const totalTime = (laps: typeof fm) => laps.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);
    const fmtTime = (sec: number) => {
      if (sec <= 0) return "—";
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    return {
      fm: { laps: fm.length, time: fmtTime(totalTime(fm)) },
      f1: { laps: f1.length, time: fmtTime(totalTime(f1)) },
      acc: { laps: acc.length, time: fmtTime(totalTime(acc)) },
    };
  }, [allLaps]);

  // Period metrics
  const [periodTab, setPeriodTab] = useState<"today" | "week" | "month" | "year" | "allTime">("allTime");

  const [{ todayStart, weekAgo, monthAgo, yearAgo }] = useState(() => {
    const now = Date.now();
    return {
      todayStart: new Date().setHours(0, 0, 0, 0),
      weekAgo: now - 7 * 24 * 60 * 60 * 1000,
      monthAgo: now - 30 * 24 * 60 * 60 * 1000,
      yearAgo: now - 365 * 24 * 60 * 60 * 1000,
    };
  });

  const periodStats = useMemo(() => {
    function computePeriod(laps: LapMeta[]) {
      const valid = laps.filter((l) => l.isValid && l.lapTime > 0);
      const best = valid.length > 0 ? Math.min(...valid.map((l) => l.lapTime)) : 0;
      const avgTime = valid.length > 0 ? valid.reduce((s, l) => s + l.lapTime, 0) / valid.length : 0;
      const totalTime = laps.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);
      const tracks = new Set(laps.map((l) => l.trackOrdinal).filter(Boolean)).size;
      const cars = new Set(laps.map((l) => l.carOrdinal).filter(Boolean)).size;
      const carCounts = new Map<number, number>();
      for (const l of laps) {
        if (l.carOrdinal) carCounts.set(l.carOrdinal, (carCounts.get(l.carOrdinal) ?? 0) + 1);
      }
      let favCarOrd: number | null = null;
      let favCarCount = 0;
      for (const [ord, count] of carCounts) {
        if (count > favCarCount) { favCarOrd = ord; favCarCount = count; }
      }
      return { laps: laps.length, valid: valid.length, best, avgTime, totalTime, tracks, cars, favCarOrd, favCarCount };
    }

    const todayLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= todayStart);
    const weekLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= weekAgo);
    const monthLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= monthAgo);
    const yearLaps = allLaps.filter((l) => new Date(l.createdAt).getTime() >= yearAgo);

    return {
      today: computePeriod(todayLaps),
      week: computePeriod(weekLaps),
      month: computePeriod(monthLaps),
      year: computePeriod(yearLaps),
      allTime: computePeriod(allLaps),
    };
  }, [allLaps, todayStart, weekAgo, monthAgo, yearAgo]);

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
      {/* Header */}
      {gameId ? (() => {
        const themes: Record<string, { bg: string; border: string; glow: string; bar: string; line: string; accent: string; logo: ReactNode }> = {
          "fm-2023": {
            bg: "linear-gradient(135deg, #060a14 0%, #0a1628 40%, #0d2040 100%)",
            border: "border-cyan-500/20",
            glow: "rgba(0,212,255,0.15)",
            bar: "#00d4ff",
            line: "#00d4ff",
            accent: "text-cyan-400",
            logo: <img src="/forza-logo.svg" alt="" className="w-6 h-6" style={{ filter: "brightness(0) saturate(100%) invert(72%) sepia(98%) saturate(1234%) hue-rotate(152deg) brightness(101%) contrast(101%)" }} />,
          },
          "f1-2025": {
            bg: "linear-gradient(135deg, #0e0606 0%, #1a0808 40%, #2d0a0a 100%)",
            border: "border-red-500/20",
            glow: "rgba(255,26,26,0.15)",
            bar: "#ff1a1a",
            line: "#ff1a1a",
            accent: "text-red-400",
            logo: <img src="/f1-logo.svg" alt="" className="w-6 h-6" style={{ filter: "brightness(0) saturate(100%) invert(28%) sepia(67%) saturate(5839%) hue-rotate(350deg) brightness(100%) contrast(107%)" }} />,
          },
          acc: {
            bg: "linear-gradient(135deg, #0e0a04 0%, #1a1008 40%, #2d1a0a 100%)",
            border: "border-orange-500/20",
            glow: "rgba(255,140,0,0.15)",
            bar: "#ff8c00",
            line: "#ff8c00",
            accent: "text-orange-400",
            logo: <img src="/acc-logo.png" alt="" className="w-6 h-6 object-contain" />,
          },
        };
        const t = themes[gameId] ?? themes["fm-2023"];
        return (
          <div
            className={`relative overflow-hidden rounded-lg border ${t.border} p-5`}
            style={{ background: t.bg }}
          >
            {/* Glow */}
            <div className="absolute -top-10 -right-10 w-[160px] h-[160px] rounded-full opacity-15 pointer-events-none" style={{ background: `radial-gradient(circle, ${t.glow} 0%, transparent 70%)` }} />
            {/* Bottom bar */}
            <div className="absolute bottom-0 left-0 right-0 h-[1.5px] opacity-60" style={{ background: `linear-gradient(90deg, ${t.bar} 0%, transparent 70%)` }} />
            {/* Speed lines */}
            <div className="absolute inset-0 overflow-hidden opacity-[0.05] pointer-events-none">
              <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: `linear-gradient(90deg, transparent 0%, ${t.line} 30%, transparent 100%)` }} />
              <div className="absolute top-[55%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: `linear-gradient(90deg, transparent 0%, ${t.line} 50%, transparent 100%)` }} />
              <div className="absolute top-[80%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: `linear-gradient(90deg, transparent 10%, ${t.line} 60%, transparent 100%)` }} />
            </div>
            <div className="relative flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-white/5 border border-white/10">
                  {t.logo}
                </div>
                <div className="text-base font-bold text-white/90">{gameAdapter?.displayName ?? gameId}</div>
              </div>
              {isLive && (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className={`text-sm font-semibold ${t.accent}`}>{packetsPerSec} pkt/s</span>
                </div>
              )}
            </div>
          </div>
        );
      })() : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-app-text/90">
              {displaySettings.driverName ? `Hello, ${displaySettings.driverName}` : "RaceIQ"}
            </h1>
            <p className="text-sm text-app-text/90-muted mt-0.5">Dashboard overview</p>
          </div>
          {isLive && (
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-sm text-app-text/90">Live — {packetsPerSec} pkt/s</span>
            </div>
          )}
        </div>
      )}

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
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">Laps</div>
              <div className="text-lg font-extrabold font-mono leading-none text-cyan-400">{gameStats.fm.laps}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">Time</div>
              <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.fm.time}</div>
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
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">Laps</div>
              <div className="text-lg font-extrabold font-mono leading-none text-red-500">{gameStats.f1.laps}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">Time</div>
              <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.f1.time}</div>
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
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">Laps</div>
              <div className="text-lg font-extrabold font-mono leading-none text-orange-400">{gameStats.acc.laps}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">Time</div>
              <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.acc.time}</div>
            </div>
          </div>
        </Link>
      </div>}

      {/* Period tabs + stats */}
      <div>
        <div className="flex items-center gap-1 mb-3">
          {([["today", "Today"], ["week", "This Week"], ["month", "This Month"], ["year", "This Year"], ["allTime", "All Time"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPeriodTab(key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90-muted hover:text-app-text/90"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {(() => {
          const data = periodStats[periodTab];
          const timeSec = periodTab === "allTime" ? (stats?.totalTimeSec ?? data.totalTime) : data.totalTime;
          const fmtTime = (s: number) => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
          };
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Laps" value={`${data.laps}`} />
              <StatCard label="Tracks" value={`${data.tracks}`} />
              <StatCard label="Cars" value={`${data.cars}`} />
              {timeSec > 0 && (
                <StatCard label="Time Driven" value={fmtTime(timeSec)} color="text-violet-400" />
              )}
            </div>
          );
        })()}
      </div>

      {/* Live session card */}
      {isLive && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Session"
            value="Active"
            sub={sessionTrack ? `Track #${sessionTrack}` : undefined}
            color="text-emerald-400"
          />
        </div>
      )}

      {/* Recent laps */}
      <div>
        <div className="mb-2">
          <h2 className="text-xs font-semibold text-app-text/90-muted uppercase tracking-wider">Recent Laps</h2>
        </div>
        <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} />
      </div>
    </div>
  );
}
