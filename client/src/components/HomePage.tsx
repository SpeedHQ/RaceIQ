import { tryGetGame } from "@shared/games/registry";
import type { LapMeta } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import type { DriverFingerprint } from "../../../server/ai/driver-profile-aggregate";
import { useDriverProfile, useLaps, useSessions, useSettings } from "../hooks/queries";
import { client } from "../lib/rpc";
import { getGameRoute, useGameId } from "../stores/game";
import { useUiStore } from "../stores/ui";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { formatLapTime } from "./LiveTelemetry";
import { SessionRecap } from "./SessionRecap";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="text-[10px] text-app-text/90-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="text-xs text-app-text/90-dim mt-1">{sub}</div>}
    </div>
  );
}

function RecentLapsTable({ laps, carNames, trackNames, gameId }: { laps: LapMeta[]; carNames: Record<number, string>; trackNames: Record<number, string>; gameId: string | null }) {
  const showGame = !gameId; // show game column on global homepage
  if (laps.length === 0) {
    return <div className="p-6 text-center text-app-text/90-dim">{m.home_no_laps()}</div>;
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
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${lap.gameId === "f1-2025" ? "bg-red-500/20 text-red-400" : lap.gameId === "acc" ? "bg-orange-500/20 text-orange-400" : lap.gameId === "ac-evo" ? "bg-green-500/20 text-green-400" : lap.gameId === "iracing" ? "bg-blue-500/20 text-blue-400" : "bg-app-accent/20 text-app-accent"}`}
                  >
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
                  <span className={`text-sm ${lap.isValid ? "text-emerald-400" : "text-red-400"}`}>{lap.isValid ? "\u2713" : "\u2717"}</span>
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
export interface DriverProgressCardProps {
  gameId: string;
  fingerprint: DriverFingerprint | null;
  loading?: boolean;
  error?: string | null;
  medianLapSec?: number | null;
}


/** Small deterministic snapshot for the game home; the full profile remains on /driver. */
export function DriverProgressCard({ gameId, fingerprint, loading = false, error = null, medianLapSec = null }: DriverProgressCardProps) {
  const profileHref = `${getGameRoute(gameId)}/driver`;
  const analyseHref = `${getGameRoute(gameId)}/analyse`;

  if (loading) {
    return (
      <section className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10" aria-live="polite">
        <h2 className="text-sm font-semibold text-app-text">Driver progress</h2>
        <p className="mt-2 text-sm text-app-text-muted">Analysing your measured lap history…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg bg-app-surface p-4 ring-1 ring-red-500/20" role="alert">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-app-text">Driver progress</h2>
          <a href={profileHref} className="rounded px-1 text-xs text-app-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
            Open profile
          </a>
        </div>
        <p className="mt-2 text-sm text-red-300">Measured profile unavailable: {error}</p>
      </section>
    );
  }

  if (!fingerprint?.ok || fingerprint.laps.analyzed === 0) {
    return (
      <section className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-app-text">Driver progress</h2>
          <a href={profileHref} className="rounded px-1 text-xs text-app-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
            Open profile
          </a>
        </div>
        <p className="mt-2 text-sm text-app-text-muted">No usable laps yet. Record a few clean laps to build measured progress.</p>
        <a href={analyseHref} className="mt-3 inline-flex rounded-md bg-app-accent/15 px-3 py-1.5 text-xs font-semibold text-app-accent hover:bg-app-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
          Go to lap analysis
        </a>
      </section>
    );
  }

  const topWeakness = fingerprint.weaknesses[0] ?? fingerprint.unquantifiedWeaknesses[0] ?? null;
  const consistency = fingerprint.pace.consistency;
  return (
    <section className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-app-text">Driver progress</h2>
          <p className="mt-0.5 text-xs text-app-text-muted">Measured from {fingerprint.laps.analyzed} laps · {fingerprint.confidence} confidence</p>
        </div>
        <a href={profileHref} className="rounded px-1 text-xs text-app-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent">
          View full profile →
        </a>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-app-surface-alt/30 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted">Best</div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-app-text">{fingerprint.pace.bestS != null && Number.isFinite(fingerprint.pace.bestS) ? formatLapTime(fingerprint.pace.bestS) : "—"}</div>
        </div>
        <div className="rounded-md bg-app-surface-alt/30 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted">Median</div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-app-text">{medianLapSec != null && Number.isFinite(medianLapSec) ? formatLapTime(medianLapSec) : "—"}</div>
        </div>
        <div className="rounded-md bg-app-surface-alt/30 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted">Consistency</div>
          <div className="mt-1 font-mono text-base font-bold tabular-nums text-app-text">{consistency != null ? `${Math.round(consistency)}%` : "—"}</div>
        </div>
        <div className="rounded-md bg-app-surface-alt/30 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted">Confidence</div>
          <div className="mt-1 text-base font-semibold capitalize text-app-text">{fingerprint.confidence}</div>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-amber-400/15 bg-amber-400/5 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-amber-300/80">Recurring measured weakness</div>
        <p className="mt-1 text-sm text-app-text">
          {topWeakness ? (
            <>
              {topWeakness.label}
              <span className="ml-1 text-xs text-app-text-muted">· {(topWeakness.perLapFrequency * 100).toFixed(0)}% of analysed laps</span>
            </>
          ) : (
            "No recurring weakness detected in the measured pool."
          )}
        </p>
      </div>
    </section>
  );
}


export function HomePage() {
  const gameId = useGameId();
  const gameAdapter = gameId ? tryGetGame(gameId) : null;
  const { data: allLaps = [] } = useLaps();
  const driverProfileQuery = useDriverProfile({ gameId });
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
  const medianLapSec = useMemo(() => {
    const selectedLapTimes = driverProfileQuery.data?.selectedLapTimes ?? [];
    const times = selectedLapTimes
      .filter((lap) => lap.isValid && lap.lapTime > 0)
      .map((lap) => lap.lapTime)
      .sort((a, b) => a - b);
    if (times.length === 0) return null;
    const middle = Math.floor(times.length / 2);
    return times.length % 2 === 0 ? (times[middle - 1] + times[middle]) / 2 : times[middle];
  }, [driverProfileQuery.data]);

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
        (() => {
          const themes: Record<string, { bg: string; border: string; glow: string; bar: string; line: string; accent: string; logo: ReactNode }> = {
            "fm-2023": {
              bg: "linear-gradient(135deg, #060a14 0%, #0a1628 40%, #0d2040 100%)",
              border: "border-cyan-500/20",
              glow: "rgba(0,212,255,0.15)",
              bar: "#00d4ff",
              line: "#00d4ff",
              accent: "text-cyan-400",
              logo: (
                <img
                  src="/forza-logo.svg"
                  alt=""
                  className="w-6 h-6"
                  style={{ filter: "brightness(0) saturate(100%) invert(72%) sepia(98%) saturate(1234%) hue-rotate(152deg) brightness(101%) contrast(101%)" }}
                />
              ),
            },
            "f1-2025": {
              bg: "linear-gradient(135deg, #0e0606 0%, #1a0808 40%, #2d0a0a 100%)",
              border: "border-red-500/20",
              glow: "rgba(255,26,26,0.15)",
              bar: "#ff1a1a",
              line: "#ff1a1a",
              accent: "text-red-400",
              logo: (
                <img
                  src="/f1-logo.svg"
                  alt=""
                  className="w-6 h-6"
                  style={{ filter: "brightness(0) saturate(100%) invert(28%) sepia(67%) saturate(5839%) hue-rotate(350deg) brightness(100%) contrast(107%)" }}
                />
              ),
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
            "ac-evo": {
              bg: "linear-gradient(135deg, #030e06 0%, #071a0c 40%, #0a2d14 100%)",
              border: "border-green-500/20",
              glow: "rgba(0,230,118,0.15)",
              bar: "#00e676",
              line: "#00e676",
              accent: "text-green-400",
              logo: <span className="text-xs font-black text-green-400">ACE</span>,
            },
            iracing: {
              bg: "linear-gradient(135deg, #040912 0%, #07172c 40%, #092b52 100%)",
              border: "border-blue-500/20",
              glow: "rgba(59,130,246,0.15)",
              bar: "#3b82f6",
              line: "#3b82f6",
              accent: "text-blue-400",
              logo: <span className="text-xs font-black text-blue-400">iR</span>,
            },
          };
          const t = themes[gameId] ?? themes["fm-2023"];
          return (
            <div className={`relative overflow-hidden rounded-lg border ${t.border} p-5`} style={{ background: t.bg }}>
              {/* Glow */}
              <div
                className="absolute -top-10 -right-10 w-[160px] h-[160px] rounded-full opacity-15 pointer-events-none"
                style={{ background: `radial-gradient(circle, ${t.glow} 0%, transparent 70%)` }}
              />
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
                  <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 bg-white/5 border border-white/10">{t.logo}</div>
                  <div className="text-base font-bold text-white/90">{gameAdapter?.displayName ?? gameId}</div>
                </div>
              </div>
            </div>
          );
        })()
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-app-text/90">{displaySettings.driverName ? `${m.home_hello()}, ${displaySettings.driverName}` : "RaceIQ"}</h1>
            <p className="text-sm text-app-text/90-muted mt-0.5">{m.home_dashboard_overview()}</p>
          </div>
          <button
            type="button"
            onClick={() => openSettings("games")}
            className="p-1.5 rounded text-app-text-muted hover:text-app-text hover:bg-app-surface-alt transition-colors"
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
              className="group md:flex-1 relative overflow-hidden rounded-lg border border-cyan-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-cyan-500/35 hover:shadow-[0_8px_32px_rgba(0,212,255,0.1)]"
              style={{ background: "linear-gradient(135deg, #060a14 0%, #0a1628 40%, #0d2040 100%)" }}
            >
              {/* Accent glow */}
              <div
                className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20"
                style={{ background: "radial-gradient(circle, rgba(0,212,255,0.15) 0%, transparent 70%)" }}
              />
              {/* Bottom accent bar */}
              <div
                className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100"
                style={{ background: "linear-gradient(90deg, #00d4ff 0%, transparent 70%)" }}
              />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="absolute top-[18%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #00d4ff 30%, transparent 100%)" }} />
                <div className="absolute top-[45%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #00d4ff 50%, transparent 100%)" }} />
                <div className="absolute top-[72%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #00d4ff 60%, transparent 100%)" }} />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-cyan-500/8 border border-cyan-500/10">
                  <img
                    src="/forza-logo.svg"
                    alt=""
                    className="w-5 h-5"
                    style={{ filter: "brightness(0) saturate(100%) invert(72%) sepia(98%) saturate(1234%) hue-rotate(152deg) brightness(101%) contrast(101%)" }}
                  />
                </div>
                <span className="text-sm font-bold text-white/90">Forza Motorsport</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_laps()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-cyan-400">{gameStats.fm.laps}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.fm.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("f1-2025") && (
            <Link
              to="/f125"
              className="group md:flex-1 relative overflow-hidden rounded-lg border border-red-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-red-500/35 hover:shadow-[0_8px_32px_rgba(255,26,26,0.1)]"
              style={{ background: "linear-gradient(135deg, #0e0606 0%, #1a0808 40%, #2d0a0a 100%)" }}
            >
              {/* Accent glow */}
              <div
                className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20"
                style={{ background: "radial-gradient(circle, rgba(255,26,26,0.15) 0%, transparent 70%)" }}
              />
              {/* Bottom accent bar */}
              <div
                className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100"
                style={{ background: "linear-gradient(90deg, #ff1a1a 0%, transparent 70%)" }}
              />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff1a1a 30%, transparent 100%)" }} />
                <div className="absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff1a1a 50%, transparent 100%)" }} />
                <div className="absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #ff1a1a 60%, transparent 100%)" }} />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-red-500/8 border border-red-500/10">
                  <img
                    src="/f1-logo.svg"
                    alt=""
                    className="w-5 h-5"
                    style={{ filter: "brightness(0) saturate(100%) invert(28%) sepia(67%) saturate(5839%) hue-rotate(350deg) brightness(100%) contrast(107%)" }}
                  />
                </div>
                <span className="text-sm font-bold text-white/90">F1 2025</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_laps()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-red-500">{gameStats.f1.laps}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.f1.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("acc") && (
            <Link
              to="/acc"
              className="group md:flex-1 relative overflow-hidden rounded-lg border border-orange-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-orange-500/35 hover:shadow-[0_8px_32px_rgba(255,140,0,0.1)]"
              style={{ background: "linear-gradient(135deg, #0e0a04 0%, #1a1008 40%, #2d1a0a 100%)" }}
            >
              {/* Accent glow */}
              <div
                className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20"
                style={{ background: "radial-gradient(circle, rgba(255,140,0,0.15) 0%, transparent 70%)" }}
              />
              {/* Bottom accent bar */}
              <div
                className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100"
                style={{ background: "linear-gradient(90deg, #ff8c00 0%, transparent 70%)" }}
              />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff8c00 30%, transparent 100%)" }} />
                <div className="absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #ff8c00 50%, transparent 100%)" }} />
                <div className="absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #ff8c00 60%, transparent 100%)" }} />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-orange-500/8 border border-orange-500/10">
                  <img src="/acc-logo.png" alt="" className="w-5 h-5 object-contain" />
                </div>
                <span className="text-sm font-bold text-white/90">Assetto Corsa Competizione</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_laps()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-orange-400">{gameStats.acc.laps}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.acc.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("ac-evo") && (
            <Link
              to="/ac-evo"
              className="group md:flex-1 relative overflow-hidden rounded-lg border border-green-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-green-500/35 hover:shadow-[0_8px_32px_rgba(0,230,118,0.1)]"
              style={{ background: "linear-gradient(135deg, #030e06 0%, #071a0c 40%, #0a2d14 100%)" }}
            >
              {/* Accent glow */}
              <div
                className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20"
                style={{ background: "radial-gradient(circle, rgba(0,230,118,0.15) 0%, transparent 70%)" }}
              />
              {/* Bottom accent bar */}
              <div
                className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100"
                style={{ background: "linear-gradient(90deg, #00e676 0%, transparent 70%)" }}
              />
              {/* Speed lines */}
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #00e676 30%, transparent 100%)" }} />
                <div className="absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #00e676 50%, transparent 100%)" }} />
                <div className="absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #00e676 60%, transparent 100%)" }} />
              </div>
              {/* Icon + Name */}
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-green-500/8 border border-green-500/10">
                  <span className="text-xs font-black text-green-400">ACE</span>
                </div>
                <span className="text-sm font-bold text-white/90">Assetto Corsa Evo</span>
              </div>
              {/* Stats */}
              <div className="relative flex gap-5">
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_laps()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-green-400">{gameStats.acEvo.laps}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.acEvo.time}</div>
                </div>
              </div>
            </Link>
          )}
          {!hiddenGames.includes("iracing") && (
            <Link
              to="/iracing"
              className="group md:flex-1 relative overflow-hidden rounded-lg border border-blue-500/12 p-5 transition-all duration-250 ease-out hover:scale-[1.02] hover:border-blue-500/35 hover:shadow-[0_8px_32px_rgba(59,130,246,0.1)]"
              style={{ background: "linear-gradient(135deg, #040912 0%, #07172c 40%, #092b52 100%)" }}
            >
              <div
                className="absolute -top-8 -right-8 w-[120px] h-[120px] rounded-full transition-opacity duration-250 opacity-10 group-hover:opacity-20"
                style={{ background: "radial-gradient(circle, rgba(59,130,246,0.15) 0%, transparent 70%)" }}
              />
              <div
                className="absolute bottom-0 left-0 right-0 h-[1.5px] transition-opacity duration-250 opacity-50 group-hover:opacity-100"
                style={{ background: "linear-gradient(90deg, #3b82f6 0%, transparent 70%)" }}
              />
              <div className="absolute inset-0 overflow-hidden opacity-[0.06] pointer-events-none">
                <div className="absolute top-[20%] -left-[10%] w-[120%] h-[1.5px] -rotate-[4deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #3b82f6 30%, transparent 100%)" }} />
                <div className="absolute top-[50%] -left-[10%] w-[120%] h-px -rotate-[3deg]" style={{ background: "linear-gradient(90deg, transparent 0%, #3b82f6 50%, transparent 100%)" }} />
                <div className="absolute top-[75%] -left-[10%] w-[120%] h-[1.5px] -rotate-[5deg]" style={{ background: "linear-gradient(90deg, transparent 10%, #3b82f6 60%, transparent 100%)" }} />
              </div>
              <div className="relative flex items-center gap-2.5 mb-3.5">
                <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-blue-500/8 border border-blue-500/10">
                  <span className="text-xs font-black text-blue-400">iR</span>
                </div>
                <span className="text-sm font-bold text-white/90">iRacing</span>
              </div>
              <div className="relative flex gap-5">
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_laps()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-blue-400">{gameStats.iracing.laps}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-[1.5px] text-white/60 mb-0.5">{m.label_time()}</div>
                  <div className="text-lg font-extrabold font-mono leading-none text-white/70">{gameStats.iracing.time}</div>
                </div>
              </div>
            </Link>
          )}
        </div>
      )}

      {gameId && (
        <DriverProgressCard
          gameId={gameId}
          fingerprint={driverProfileQuery.data?.fingerprint ?? null}
          loading={driverProfileQuery.isLoading}
          error={driverProfileQuery.error instanceof Error ? driverProfileQuery.error.message : driverProfileQuery.error ? String(driverProfileQuery.error) : null}
          medianLapSec={medianLapSec}
        />
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
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90-muted hover:text-app-text/90"}`}
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
              {timeSec > 0 && <StatCard label={m.home_stat_time_driven()} value={fmtTime(timeSec)} color="text-violet-400" />}
            </div>
          );
        })()}
      </div>

      {/* Recent laps */}
      <div>
        <div className="mb-2">
          <h2 className="text-xs font-semibold text-app-text/90-muted uppercase tracking-wider">{m.home_recent_laps()}</h2>
        </div>
        <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} />
      </div>
    </div>
  );
}
