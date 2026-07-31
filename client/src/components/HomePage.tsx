import type { GameId, LapMeta, SessionMeta, SessionRecap as SessionRecapDto } from "@shared/types";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { m } from "@/paraglide/messages";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { formatLapTime } from "./LiveTelemetry";
import { SessionRecapView, type TrackOutlineData, type TrackSectorBounds } from "./SessionRecap";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

function GameBrandLogo({ gameId, className = "w-5 h-5" }: { gameId: string; className?: string }) {
  if (gameId === "fm-2023") return <img src="/forza-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "f1-2025") return <img src="/f1-logo.svg" alt="" className={`game-brand-logo ${className}`} />;
  if (gameId === "acc") return <img src="/acc-logo.png" alt="" className={`object-contain ${className}`} />;
  return <span className="game-brand-accent text-xs font-black">{gameId === "iracing" ? "iR" : "ACE"}</span>;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-4">
      <div className="text-app-caption text-app-text/90 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-3xl font-mono font-black tabular-nums leading-none ${color ?? "text-app-text/90"}`}>{value}</div>
      {sub && <div className="text-xs text-app-text/90 mt-1">{sub}</div>}
    </div>
  );
}

function RecentLapsTable({
  laps,
  carNames,
  trackNames,
  gameId,
  onAnalyseLap,
}: {
  laps: LapMeta[];
  carNames: Record<number, string>;
  trackNames: Record<number, string>;
  gameId: string | null;
  onAnalyseLap: (lap: LapMeta) => void;
}) {
  const showGame = !gameId; // show game column on global homepage
  if (laps.length === 0) {
    return <div className="p-6 text-center text-app-text/90">{m.home_no_laps()}</div>;
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
                onAnalyseLap(lap);
              }}
            >
              {showGame && (
                <TD>
                  <Badge variant="neutral" size="compact" data-game-brand={lap.gameId ?? "fm-2023"} className="game-brand-badge border-transparent text-app-caption font-semibold">
                    {lap.gameId === "f1-2025" ? "F1" : lap.gameId === "acc" ? "ACC" : lap.gameId === "ac-evo" ? "ACE" : lap.gameId === "iracing" ? "iR" : "FM"}
                  </Badge>
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
export type PeriodKey = "today" | "week" | "month" | "year" | "allTime";
export type PeriodStats = Record<
  PeriodKey,
  {
    laps: number;
    valid: number;
    best: number;
    avgTime: number;
    totalTime: number;
    tracks: number;
    cars: number;
    sessions: number;
    favCarOrd: number | null;
    favCarCount: number;
  }
>;
export type GameStats = Record<"fm" | "f1" | "acc" | "acEvo" | "iracing", { laps: number; time: string }>;

export interface HomePageViewProps {
  gameId: GameId | null;
  gameDisplayName: string | null;
  displaySettings: { driverName?: string | null; hiddenGames?: string[] };
  allLaps: LapMeta[];
  recentLaps: LapMeta[];
  carNames: Record<number, string>;
  trackNames: Record<number, string>;
  gameStats: GameStats;
  hiddenGames: string[];
  latestSession: SessionMeta | null;
  latestRecap: SessionRecapDto | null | undefined;
  latestRecapLoading: boolean;
  latestRecapError: boolean;
  latestRecapOutline?: TrackOutlineData;
  latestRecapBounds?: TrackSectorBounds;
  recapCopied: boolean;
  onCopyRecap: () => void;
  onAnalyseLap: (lap: LapMeta) => void;
  lapsLoading?: boolean;
  lapsError?: boolean;
  sessionsLoading?: boolean;
  sessionsError?: boolean;
  onAnalyseRecap: () => void;
  periodTab: PeriodKey;
  periodStats: PeriodStats;
  onPeriodTabChange: (period: PeriodKey) => void;
  onOpenSettings: () => void;
}

export function HomePageView({
  gameId,
  gameDisplayName,
  displaySettings,
  allLaps,
  recentLaps,
  carNames,
  trackNames,
  gameStats,
  hiddenGames,
  latestSession,
  latestRecap,
  latestRecapLoading,
  latestRecapError,
  latestRecapOutline,
  latestRecapBounds,
  recapCopied,
  onCopyRecap,
  onAnalyseLap,
  onAnalyseRecap,
  periodTab,
  periodStats,
  onPeriodTabChange,
  onOpenSettings,
}: HomePageViewProps) {
  return (
    <div className="min-h-full bg-app-bg">
      <div className="mx-auto max-w-[1400px] p-4 md:p-6 space-y-6">
        {/* Header */}
        {gameId ? (
          <div data-game-brand={gameId} className="game-brand-panel relative overflow-hidden rounded-lg border p-5">
            <div className="game-brand-glow absolute -top-10 -right-10 w-[160px] h-[160px] rounded-full opacity-15 pointer-events-none" />
            <div className="game-brand-bar absolute bottom-0 left-0 right-0 h-[1.5px] opacity-60" />
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
                <div className="text-base font-bold text-app-text/90">{gameDisplayName ?? gameId}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-app-text/90">{displaySettings.driverName ? `${m.home_hello()}, ${displaySettings.driverName}` : "RaceIQ"}</h1>
              <p className="text-sm text-app-text/90 mt-0.5">{m.home_dashboard_overview()}</p>
            </div>
            <Button
              variant="app-ghost"
              size="icon-sm"
              onClick={onOpenSettings}
              className="!h-auto !w-auto p-1.5 text-app-text-muted hover:text-app-text hover:bg-app-surface-hover"
              title={m.home_manage_games()}
            >
              <Settings2 className="size-4" />
            </Button>
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

        {gameId ? (
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <main className="min-w-0 space-y-6">
              <section>
                <ActivityHeatmap laps={allLaps.filter((l) => l.gameId === gameId)} />
              </section>

              <section>
                <div className="mb-3 flex flex-wrap items-center gap-1">
                  {(
                    [
                      ["today", m.home_period_today()],
                      ["week", m.home_period_week()],
                      ["month", m.home_period_month()],
                      ["year", m.home_period_year()],
                      ["allTime", m.home_period_all_time()],
                    ] as const
                  ).map(([key, label]) => (
                    <Button
                      variant="app-ghost"
                      size="app-sm"
                      key={key}
                      onClick={() => onPeriodTabChange(key)}
                      className={`!px-3 !py-1.5 text-xs font-semibold transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90 hover:text-app-text"}`}
                    >
                      {label}
                    </Button>
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
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                      <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
                      <StatCard label={m.label_laps()} value={`${data.laps}`} />
                      <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
                      <StatCard label={m.label_cars()} value={`${data.cars}`} />
                      {timeSec > 0 && <StatCard label={m.home_stat_time_driven()} value={fmtTime(timeSec)} color="text-app-accent" />}
                    </div>
                  );
                })()}
              </section>

              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text/90">{m.home_recent_laps()}</h2>
                <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseLap={onAnalyseLap} />
              </section>
            </main>

            <aside className="lg:sticky lg:top-6">
              {latestSession ? (
                <div className="relative overflow-hidden rounded-xl border border-app-border bg-app-bg p-4">
                  <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-app-accent opacity-15 blur-3xl" />
                  <div className="relative mb-3 flex items-center gap-2 text-app-caption font-semibold uppercase tracking-app-label text-app-accent">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-app-accent shadow-[var(--app-glow-accent)]" />
                    {m.recap_latest_session()}
                  </div>
                  {latestRecapLoading ? (
                    <div className="p-6 text-center text-app-text-dim">{m.common_loading()}</div>
                  ) : latestRecapError || !latestRecap ? (
                    <div className="p-6 text-center text-status-danger">{m.common_error()}</div>
                  ) : (
                    <SessionRecapView
                      recap={latestRecap}
                      gameId={latestRecap.gameId}
                      linkToAnalyse
                      copied={recapCopied}
                      onCopy={onCopyRecap}
                      onAnalyse={onAnalyseRecap}
                      outlineData={latestRecapOutline}
                      bounds={latestRecapBounds}
                    />
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface p-6 text-center text-xs text-app-text-muted">{m.recap_latest_session()}</div>
              )}
            </aside>
          </div>
        ) : (
          <>
            {latestSession && (
              <div className="rounded-lg border border-app-border bg-app-surface p-4">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text-muted">{m.recap_latest_session()}</h2>
                {latestRecapLoading ? (
                  <div className="p-6 text-center text-app-text-dim">{m.common_loading()}</div>
                ) : latestRecapError || !latestRecap ? (
                  <div className="p-6 text-center text-status-danger">{m.common_error()}</div>
                ) : (
                  <SessionRecapView
                    recap={latestRecap}
                    gameId={latestRecap.gameId}
                    linkToAnalyse
                    copied={recapCopied}
                    onCopy={onCopyRecap}
                    onAnalyse={onAnalyseRecap}
                    outlineData={latestRecapOutline}
                    bounds={latestRecapBounds}
                  />
                )}
              </div>
            )}

            <ActivityHeatmap laps={allLaps} />

            <div>
              <div className="mb-3 flex flex-wrap items-center gap-1">
                {(
                  [
                    ["today", m.home_period_today()],
                    ["week", m.home_period_week()],
                    ["month", m.home_period_month()],
                    ["year", m.home_period_year()],
                    ["allTime", m.home_period_all_time()],
                  ] as const
                ).map(([key, label]) => (
                  <Button
                    variant="app-ghost"
                    size="app-sm"
                    key={key}
                    onClick={() => onPeriodTabChange(key)}
                    className={`!px-3 !py-1.5 text-xs font-semibold transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90 hover:text-app-text"}`}
                  >
                    {label}
                  </Button>
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
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
                    <StatCard label={m.label_laps()} value={`${data.laps}`} />
                    <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
                    <StatCard label={m.label_cars()} value={`${data.cars}`} />
                    {timeSec > 0 && <StatCard label={m.home_stat_time_driven()} value={fmtTime(timeSec)} color="text-app-accent" />}
                  </div>
                );
              })()}
            </div>

            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text/90">{m.home_recent_laps()}</h2>
              <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseLap={onAnalyseLap} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
