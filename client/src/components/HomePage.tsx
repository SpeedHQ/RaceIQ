import { tryGetGame } from "@shared/games/registry";
import type { LapMeta } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { useLaps, useSessions, useSettings } from "../hooks/queries";
import { client } from "../lib/rpc";
import { getGameRoute, useGameId } from "../stores/game";
import { useUiStore } from "../stores/ui";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { formatLapTime } from "./LiveTelemetry";
import { SessionRecap } from "./SessionRecap";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";

function GameBrandLogo({ gameId, className = "w-5 h-5" }: { gameId: string; className?: string }) {
  if (gameId === "fm-2023") return <img src="/forza-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "f1-2025") return <img src="/f1-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "acc") return <img src="/acc-logo.png" alt="" className={`object-contain ${className}`} />;
  return <span className="game-brand-accent text-xs font-black">{gameId === "iracing" ? "iR" : "ACE"}</span>;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="text-app-caption text-app-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="text-xs text-app-text-dim mt-1">{sub}</div>}
    </div>
  );
}

function RecentLapsTable({ laps, carNames, trackNames, gameId }: { laps: LapMeta[]; carNames: Record<number, string>; trackNames: Record<number, string>; gameId: string | null }) {
  const showGame = !gameId; // show game column on global homepage
  if (laps.length === 0) {
    return <div className="p-6 text-center text-app-text-dim">{m.home_no_laps()}</div>;
  }

  return (
    <Table>
      <THead>
        {showGame && <TH>{m.home_col_game()}</TH>}
        <TH>{m.label_track()}</TH>
        <TH>{m.label_car()}</TH>
        <TH>{m.label_lap()}</TH>
        <TH>{m.label_time()}</TH>
        <TH className="text-right">{m.home_col_when()}</TH>
      </THead>
      <TBody>
        {laps.map((lap) => {
          const track = lap.trackOrdinal != null ? (trackNames[lap.trackOrdinal] ?? "") : "";
          const car = lap.carOrdinal != null ? (carNames[lap.carOrdinal] ?? "") : "";
          const ago = formatTimeAgo(new Date(lap.createdAt));
          return (
            <TRow
              key={lap.id}
              onClick={() => {
                if (!lap.gameId) return;
                window.location.href = `${getGameRoute(lap.gameId)}/analyse?track=${lap.trackOrdinal ?? ""}&car=${lap.carOrdinal ?? ""}&lap=${lap.id}`;
              }}
            >
              {showGame && (
                <TD>
                  <span data-game-brand={lap.gameId ?? "fm-2023"} className="game-brand-badge text-app-caption font-semibold px-1.5 py-0.5 rounded">
                    {lap.gameId === "f1-2025" ? "F1" : lap.gameId === "acc" ? "ACC" : lap.gameId === "ac-evo" ? "ACE" : lap.gameId === "iracing" ? "iR" : "FM"}
                  </span>
                </TD>
              )}
              <TD className="text-app-text/90 truncate max-w-[160px]" title={track}>
                {track || "—"}
              </TD>
              <TD className="text-app-text/90 truncate max-w-[140px]" title={car}>
                {car || "—"}
              </TD>
              <TD className="font-mono text-app-text/90">{lap.lapNumber}</TD>
              <TD className="font-mono font-bold text-app-text/90 tabular-nums whitespace-nowrap">
                <span className="flex items-center gap-1">
                  {formatLapTime(lap.lapTime)}
                  <span className={`text-sm ${lap.isValid ? "text-status-success" : "text-status-danger"}`}>{lap.isValid ? "\u2713" : "\u2717"}</span>
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
  if (sec < 60) return m.home_just_now();
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${m.home_minutes_ago()}`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${m.home_hours_ago()}`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ${m.home_days_ago()}`;
  return date.toLocaleDateString();
}

export function HomePage() {
  const gameId = useGameId();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const { data: allLaps = [] } = useLaps();
  const { data: sessions = [] } = useSessions();
  const { displaySettings } = useSettings();
  const { openSettings } = useUiStore();
  const hiddenGames: string[] = displaySettings.hiddenGames ?? [];

  const latestSession = useMemo(() => {
    if (sessions.length === 0) return null;
    return [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [sessions]);

  // Resolve car/track names for recent laps
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});

  const recentLaps = useMemo(
    () =>
      [...allLaps]
        .filter((l) => l.lapTime > 0)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
    [allLaps],
  );

  // Per-game stats — fetched from /api/stats per game so counts aren't
  // capped by useLaps()'s 200-row limit (home and /<gameId> used to
  // disagree when total laps across games exceeded 200).
  const gameQueries = useQueries({
    queries: (["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"] as const).map((g) => ({
      queryKey: ["stats", g],
      queryFn: async () => {
        const res = await client.api.stats.$get({ query: { gameId: g } });
        if (!res.ok) throw new Error(res.statusText);
        return res.json() as Promise<{ totalLaps: number; totalTimeSec: number }>;
      },
    })),
  });

  const gameStats = useMemo(() => {
    const fmtTime = (sec: number) => {
      if (sec <= 0) return "—";
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const pick = (i: number) => {
      const d = gameQueries[i].data;
      return { laps: d?.totalLaps ?? 0, time: fmtTime(d?.totalTimeSec ?? 0) };
    };
    return { fm: pick(0), f1: pick(1), acc: pick(2), acEvo: pick(3), iracing: pick(4) };
  }, [gameQueries]);

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
      const sessions = new Set(laps.map((l) => l.sessionId).filter(Boolean)).size;
      const carCounts = new Map<number, number>();
      for (const l of laps) {
        if (l.carOrdinal) carCounts.set(l.carOrdinal, (carCounts.get(l.carOrdinal) ?? 0) + 1);
      }
      let favCarOrd: number | null = null;
      let favCarCount = 0;
      for (const [ord, count] of carCounts) {
        if (count > favCarCount) {
          favCarOrd = ord;
          favCarCount = count;
        }
      }
      return { laps: laps.length, valid: valid.length, best, avgTime, totalTime, tracks, cars, sessions, favCarOrd, favCarCount };
    }

    const gameLaps = gameId ? allLaps.filter((l) => l.gameId === gameId) : allLaps;

    const todayLaps = gameLaps.filter((l) => new Date(l.createdAt).getTime() >= todayStart);
    const weekLaps = gameLaps.filter((l) => new Date(l.createdAt).getTime() >= weekAgo);
    const monthLaps = gameLaps.filter((l) => new Date(l.createdAt).getTime() >= monthAgo);
    const yearLaps = gameLaps.filter((l) => new Date(l.createdAt).getTime() >= yearAgo);

    return {
      today: computePeriod(todayLaps),
      week: computePeriod(weekLaps),
      month: computePeriod(monthLaps),
      year: computePeriod(yearLaps),
      allTime: computePeriod(gameLaps),
    };
  }, [allLaps, gameId, todayStart, weekAgo, monthAgo, yearAgo]);

  // Fetch names for recent laps + favourite cars
  useEffect(() => {
    const carOrds = [...new Set([...recentLaps.map((l) => l.carOrdinal), periodStats.today.favCarOrd, periodStats.week.favCarOrd, periodStats.month.favCarOrd].filter((o): o is number => o != null))];
    const trackOrds = [...new Set(recentLaps.map((l) => l.trackOrdinal).filter((o): o is number => o != null))];
    for (const ord of carOrds) {
      if (carNames[ord]) continue;
      // Find the gameId from a lap that has this ordinal
      const lapForCar = recentLaps.find((l) => l.carOrdinal === ord);
      client.api["car-name"][":ordinal"]
        .$get({ param: { ordinal: String(ord) }, query: { gameId: (lapForCar?.gameId ?? gameId)! } })
        .then((r) => (r.ok ? r.text() : ""))
        .then((name) => setCarNames((prev) => ({ ...prev, [ord]: name })))
        .catch(() => {});
    }
    for (const ord of trackOrds) {
      if (trackNames[ord]) continue;
      const lapForTrack = recentLaps.find((l) => l.trackOrdinal === ord);
      client.api["track-name"][":ordinal"]
        .$get({ param: { ordinal: String(ord) }, query: { gameId: (lapForTrack?.gameId ?? gameId)! } })
        .then((r) => (r.ok ? r.text() : ""))
        .then((name) => setTrackNames((prev) => ({ ...prev, [ord]: name })))
        .catch(() => {});
    }
  }, [recentLaps, periodStats, gameId]);

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      {gameId ? (
        <div data-game-brand={gameId} className="game-brand-panel relative overflow-hidden rounded-lg border p-5">
          {/* Glow */}
          <div className="game-brand-glow absolute -top-10 -right-10 w-[160px] h-[160px] rounded-full opacity-15 pointer-events-none" />
          {/* Bottom bar */}
          <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] opacity-60" />
          {/* Speed lines */}
          <div className="absolute inset-0 overflow-hidden opacity-[0.05] pointer-events-none">
            <div className="game-brand-speed-line game-brand-line-30 absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
            <div className="game-brand-speed-line game-brand-line-50 absolute top-[55%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
            <div className="game-brand-speed-line game-brand-line-60 absolute top-[80%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
          </div>
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="game-brand-icon w-9 h-9 rounded-md border flex items-center justify-center shrink-0">
                <GameBrandLogo gameId={gameId} className="w-6 h-6" />
              </div>
              <div className="text-base font-bold text-app-text/90">{gameAdapter?.displayName ?? gameId}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-app-text/90">{displaySettings.driverName ? `${m.home_hello()}, ${displaySettings.driverName}` : "RaceIQ"}</h1>
            <p className="text-sm text-app-text-muted mt-0.5">{m.home_dashboard_overview()}</p>
          </div>
          <button
            type="button"
            onClick={() => openSettings("games")}
            className="p-1.5 rounded text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
            title={m.home_manage_games()}
          >
            <Settings2 className="size-4" />
          </button>
        </div>
      )}

      {/* Game cards — only on global homepage */}
      {!gameId && (
        <div className="grid grid-cols-2 md:flex gap-3">
          {!hiddenGames.includes("fm-2023") && (
            <Link
              to="/fm23"
              data-game-brand="fm-2023"
              className="game-brand-panel game-brand-card group md:flex-1 relative overflow-hidden rounded-lg border p-5 transition-all duration-250 ease-out hover:scale-[1.02]"
            >
              {/* Accent glow */}
              <div className="game-brand-glow absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" />
              {/* Bottom accent bar */}
              <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="game-brand-speed-line game-brand-line-30 absolute top-[18%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
                <div className="game-brand-speed-line game-brand-line-50 absolute top-[45%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
                <div className="game-brand-speed-line game-brand-line-60 absolute top-[72%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="game-brand-icon w-8 h-8 rounded-md border flex items-center justify-center shrink-0">
                  <GameBrandLogo gameId="fm-2023" />
                </div>
                <span className="text-sm font-bold text-app-text/90">Forza Motorsport</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_laps()}</div>
                  <div className="game-brand-accent text-lg font-extrabold font-mono leading-none">{gameStats.fm.laps}</div>
                </div>
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-app-text/70">{gameStats.fm.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("f1-2025") && (
            <Link
              to="/f125"
              data-game-brand="f1-2025"
              className="game-brand-panel game-brand-card group md:flex-1 relative overflow-hidden rounded-lg border p-5 transition-all duration-250 ease-out hover:scale-[1.02]"
            >
              {/* Accent glow */}
              <div className="game-brand-glow absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" />
              {/* Bottom accent bar */}
              <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="game-brand-speed-line game-brand-line-30 absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
                <div className="game-brand-speed-line game-brand-line-50 absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
                <div className="game-brand-speed-line game-brand-line-60 absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="game-brand-icon w-8 h-8 rounded-md border flex items-center justify-center shrink-0">
                  <GameBrandLogo gameId="f1-2025" />
                </div>
                <span className="text-sm font-bold text-app-text/90">F1 2025</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_laps()}</div>
                  <div className="game-brand-accent text-lg font-extrabold font-mono leading-none">{gameStats.f1.laps}</div>
                </div>
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-app-text/70">{gameStats.f1.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("acc") && (
            <Link
              to="/acc"
              data-game-brand="acc"
              className="game-brand-panel game-brand-card group md:flex-1 relative overflow-hidden rounded-lg border p-5 transition-all duration-250 ease-out hover:scale-[1.02]"
            >
              {/* Accent glow */}
              <div className="game-brand-glow absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" />
              {/* Bottom accent bar */}
              <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="game-brand-speed-line game-brand-line-30 absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
                <div className="game-brand-speed-line game-brand-line-50 absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
                <div className="game-brand-speed-line game-brand-line-60 absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="game-brand-icon w-8 h-8 rounded-md border flex items-center justify-center shrink-0">
                  <GameBrandLogo gameId="acc" />
                </div>
                <span className="text-sm font-bold text-app-text/90">Assetto Corsa Competizione</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_laps()}</div>
                  <div className="game-brand-accent text-lg font-extrabold font-mono leading-none">{gameStats.acc.laps}</div>
                </div>
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-app-text/70">{gameStats.acc.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("ac-evo") && (
            <Link
              to="/ac-evo"
              data-game-brand="ac-evo"
              className="game-brand-panel game-brand-card group md:flex-1 relative overflow-hidden rounded-lg border p-5 transition-all duration-250 ease-out hover:scale-[1.02]"
            >
              {/* Accent glow */}
              <div className="game-brand-glow absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" />
              {/* Bottom accent bar */}
              <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="game-brand-speed-line game-brand-line-30 absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
                <div className="game-brand-speed-line game-brand-line-50 absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
                <div className="game-brand-speed-line game-brand-line-60 absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="game-brand-icon w-8 h-8 rounded-md border flex items-center justify-center shrink-0">
                  <GameBrandLogo gameId="ac-evo" />
                </div>
                <span className="text-sm font-bold text-app-text/90">Assetto Corsa Evo</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_laps()}</div>
                  <div className="game-brand-accent text-lg font-extrabold font-mono leading-none">{gameStats.acEvo.laps}</div>
                </div>
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-app-text/70">{gameStats.acEvo.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("iracing") && (
            <Link
              to="/iracing"
              data-game-brand="iracing"
              className="game-brand-panel game-brand-card group md:flex-1 relative overflow-hidden rounded-lg border p-5 transition-all duration-250 ease-out hover:scale-[1.02]"
            >
              <div className="game-brand-glow absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20" />
              <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100" />
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="game-brand-speed-line game-brand-line-30 absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" />
                <div className="game-brand-speed-line game-brand-line-50 absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" />
                <div className="game-brand-speed-line game-brand-line-60 absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" />
              </div>
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="game-brand-icon w-8 h-8 rounded-md border flex items-center justify-center shrink-0">
                  <GameBrandLogo gameId="iracing" />
                </div>
                <span className="text-sm font-bold text-app-text/90">iRacing</span>
              </div>
              <div className="relative flex gap-5">
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_laps()}</div>
                  <div className="game-brand-accent text-lg font-extrabold font-mono leading-none">{gameStats.iracing.laps}</div>
                </div>
                <div>
                  <div className="text-app-micro uppercase tracking-app-label text-app-text/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-app-text/70">{gameStats.iracing.time}</div>
                </div>
              </div>
            </Link>
          )}
        </div>
      )}

      {/* Latest session recap. Renders in full here, so there is no modal to open —
          clicking deep-links to analysing the session's best lap instead. */}
      {latestSession && (
        <div className="rounded-lg border border-app-border bg-app-surface p-4">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider mb-2">{m.recap_latest_session()}</h2>
          {/* gameId passed explicitly: the global home page has no active-game scope. */}
          <SessionRecap sessionId={latestSession.id} gameId={latestSession.gameId} linkToAnalyse />
        </div>
      )}

      {/* Activity heatmap */}
      <ActivityHeatmap laps={gameId ? allLaps.filter((l) => l.gameId === gameId) : allLaps} />

      {/* Period tabs + stats */}
      <div>
        <div className="flex items-center flex-wrap gap-1 mb-3">
          {(
            [
              ["today", m.home_period_today()],
              ["week", m.home_period_week()],
              ["month", m.home_period_month()],
              ["year", m.home_period_year()],
              ["allTime", m.home_period_all_time()],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              onClick={() => setPeriodTab(key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text/90"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {(() => {
          const data = periodStats[periodTab];
          const timeSec = data.totalTime;
          const fmtTime = (s: number) => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
          };
          return (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
              <StatCard label={m.label_laps()} value={`${data.laps}`} />
              <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
              <StatCard label={m.label_cars()} value={`${data.cars}`} />
              {timeSec > 0 && <StatCard label={m.home_stat_time_driven()} value={fmtTime(timeSec)} color="text-app-accent" />}
            </div>
          );
        })()}
      </div>

      {/* Recent laps */}
      <div>
        <div className="mb-2">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.home_recent_laps()}</h2>
        </div>
        <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} />
      </div>
    </div>
  );
}
