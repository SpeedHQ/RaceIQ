import { balanceReading, controlLossReading, gripMedianReading, reversalsReading, type StyleTone } from "@shared/lib/style-readings";
import type { GameId, LapMeta, SessionMeta, SessionRecap as SessionRecapDto } from "@shared/types";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { m } from "@/paraglide/messages";
import type { DriverFingerprint } from "../../../server/ai/driver-profile-aggregate";
import type { DriverProfileState } from "../hooks/queries";
import { getGameRoute } from "../stores/game";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { formatLapTime } from "./LiveTelemetry";
import { SessionRecapView, type TrackOutlineData, type TrackSectorBounds } from "./SessionRecap";
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
                onAnalyseLap(lap);
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

export interface DriverProgressCardProps {
  gameId: string;
  fingerprint: DriverFingerprint | null;
  loading?: boolean;
  error?: string | null;
  medianLapSec?: number | null;
  runState?: DriverProfileState;
}

function ProfileMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-app-border/70 bg-app-surface-alt/20 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold tabular-nums text-app-text">{value}</div>
      {detail && <div className="mt-0.5 text-[10px] text-app-text-muted">{detail}</div>}
    </div>
  );
}

const STYLE_TONE_CLASS: Record<StyleTone, string> = {
  neutral: "bg-blue-500/15 text-blue-300",
  good: "bg-emerald-500/15 text-emerald-300",
  warn: "bg-amber-500/15 text-amber-300",
  bad: "bg-red-500/15 text-red-300",
};

const STYLE_TONE_LABEL: Record<StyleTone, string> = {
  neutral: "Neutral",
  good: "Good",
  warn: "Watch",
  bad: "High",
};

function StyleWidget({ label, value, display, tone }: { label: string; value: number | null; display: string; tone: StyleTone }) {
  const measured = value != null && Number.isFinite(value);
  return (
    <div className="rounded-md border border-app-border/70 bg-app-surface-alt/20 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold tabular-nums text-app-text">{measured ? display : "Not measured"}</div>
      <span className={`mt-1 inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${measured ? STYLE_TONE_CLASS[tone] : "bg-app-surface-alt text-app-text-muted"}`}>
        {measured ? STYLE_TONE_LABEL[tone] : "Not measured"}
      </span>
    </div>
  );
}

function aiStateLabel(state: DriverProfileState): string {
  if (state === "succeeded") return "Plan ready";
  if (state === "queued") return "Queued";
  if (state === "running") return "Running";
  if (state === "failed") return "Failed";
  if (state === "disabled") return "Disabled";
  return "Not configured";
}

/** Compact driver profile glance for the per-game home dashboard. */
export function DriverProgressCard({ gameId, fingerprint, loading = false, error = null, medianLapSec = null, runState = "not-configured" }: DriverProgressCardProps) {
  const profileHref = `${getGameRoute(gameId)}/driver`;
  const analyseHref = `${getGameRoute(gameId)}/analyse`;
  const measured = fingerprint?.ok && fingerprint.laps.analyzed > 0 ? fingerprint : null;
  const style = measured?.style;
  const topWeakness = measured?.weaknesses[0] ?? measured?.unquantifiedWeaknesses[0] ?? null;

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-app-text">Driver profile</h2>
          <p className="mt-0.5 text-xs text-app-text-muted">
            {loading ? "Loading measured profile…" : error ? "Profile unavailable" : measured ? `${measured.laps.analyzed} analyzed laps` : "Build your profile from clean laps"}
          </p>
        </div>
        <a
          href={profileHref}
          className="rounded px-1 text-xs font-semibold text-app-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
        >
          View full profile →
        </a>
      </div>

      {error ? (
        <p className="mt-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
          {error}
        </p>
      ) : !measured ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-app-border px-3 py-2">
          <p className="text-xs text-app-text-muted">{loading ? "Measured signals are loading…" : "Record a few clean laps to unlock profile signals."}</p>
          {!loading && (
            <a
              href={analyseHref}
              className="rounded px-1 text-xs font-semibold text-app-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            >
              Analyse laps →
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ProfileMetric
              label="Pace"
              value={`${medianLapSec != null ? formatLapTime(medianLapSec) : "Not measured"} / ${measured.pace.bestS != null ? formatLapTime(measured.pace.bestS) : "Not measured"}`}
              detail="median / best"
            />
            <ProfileMetric label="Consistency" value={measured.pace.consistency != null ? `${Math.round(measured.pace.consistency)} / 100` : "Not measured"} />
            <ProfileMetric label="Analyzed laps" value={`${measured.laps.analyzed}`} />
            <ProfileMetric label="Confidence" value={measured.confidence} />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StyleWidget
              label="Grip"
              value={style?.gripUtilMedian ?? null}
              display={style?.gripUtilMedian == null ? "" : style.gripUtilMedian.toFixed(2)}
              tone={style?.gripUtilMedian == null ? "neutral" : gripMedianReading(style.gripUtilMedian).tone}
            />
            <StyleWidget
              label="Balance"
              value={style?.balanceMedianDeg ?? null}
              display={style?.balanceMedianDeg == null ? "" : `${style.balanceMedianDeg > 0 ? "+" : ""}${style.balanceMedianDeg.toFixed(1)}°`}
              tone={style?.balanceMedianDeg == null ? "neutral" : balanceReading(style.balanceMedianDeg).tone}
            />
            <StyleWidget
              label="Control loss"
              value={style?.controlLossFraction ?? null}
              display={style?.controlLossFraction == null ? "" : `${(style.controlLossFraction * 100).toFixed(1)}%`}
              tone={style?.controlLossFraction == null ? "neutral" : controlLossReading(style.controlLossFraction).tone}
            />
            <StyleWidget
              label="Steering variability"
              value={style?.steerReversalsPerS ?? null}
              display={style?.steerReversalsPerS == null ? "" : `${style.steerReversalsPerS.toFixed(1)} /s`}
              tone={style?.steerReversalsPerS == null ? "neutral" : reversalsReading(style.steerReversalsPerS).tone}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-app-border/70 bg-app-surface-alt/20 px-3 py-2 text-xs" aria-live="polite">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="uppercase tracking-wider text-app-text-muted">Focus</span>
              <span className="truncate font-semibold text-app-text">{topWeakness?.label ?? "No recurring weakness"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="uppercase tracking-wider text-app-text-muted">Coach</span>
              <span className={runState === "failed" ? "font-semibold text-red-300" : "font-semibold text-app-text"}>{aiStateLabel(runState)}</span>
            </div>
            <a
              href={profileHref}
              className="ml-auto rounded px-1 font-semibold text-app-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            >
              Details →
            </a>
          </div>
        </>
      )}
    </section>
  );
}

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
  driverGameId: string | null;
  driverFingerprint: DriverFingerprint | null;
  driverLoading: boolean;
  driverError: string | null;
  medianLapSec: number | null;
  driverRunState?: DriverProfileState;
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
  driverGameId,
  driverFingerprint,
  driverLoading,
  driverError,
  medianLapSec,
  driverRunState,
}: HomePageViewProps) {
  return (
    <div className="min-h-full bg-black">
    <div className="mx-auto max-w-[1400px] p-4 md:p-6 space-y-6">
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
                  <div className="text-base font-bold text-white/90">{gameDisplayName ?? gameId}</div>
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
          <button type="button" onClick={onOpenSettings} className="p-1.5 rounded text-app-text-muted hover:text-app-text hover:bg-app-surface-alt transition-colors" title={m.home_manage_games()}>
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

      {gameId ? (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <main className="min-w-0 space-y-6">
            <DriverProgressCard gameId={driverGameId ?? gameId} fingerprint={driverFingerprint} loading={driverLoading} error={driverError} medianLapSec={medianLapSec} runState={driverRunState} />

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
                  <button
                    type="button"
                    key={key}
                    onClick={() => onPeriodTabChange(key)}
                    className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90-muted hover:text-app-text/90"}`}
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
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
                    <StatCard label={m.label_laps()} value={`${data.laps}`} />
                    <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
                    <StatCard label={m.label_cars()} value={`${data.cars}`} />
                    {timeSec > 0 && <StatCard label={m.home_stat_time_driven()} value={fmtTime(timeSec)} color="text-violet-400" />}
                  </div>
                );
              })()}
            </section>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text/90-muted">{m.home_recent_laps()}</h2>
              <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseLap={onAnalyseLap} />
            </section>
          </main>

          <aside className="lg:sticky lg:top-6">
            {latestSession ? (
              <div className="relative overflow-hidden rounded-xl border border-app-border bg-app-bg p-4">
                <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-app-accent opacity-15 blur-3xl" />
                <div className="relative mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-app-accent">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-app-accent shadow-[0_0_8px_var(--color-app-accent,#7c5cff)]" />
                  {m.recap_latest_session()}
                </div>
                {latestRecapLoading ? (
                  <div className="p-6 text-center text-app-text-dim">{m.common_loading()}</div>
                ) : latestRecapError || !latestRecap ? (
                  <div className="p-6 text-center text-red-400">{m.common_error()}</div>
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
                <div className="p-6 text-center text-red-400">{m.common_error()}</div>
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
                <button
                  type="button"
                  key={key}
                  onClick={() => onPeriodTabChange(key)}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors ${periodTab === key ? "bg-app-accent/20 text-app-accent" : "text-app-text/90-muted hover:text-app-text/90"}`}
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
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <StatCard label={m.label_sessions()} value={`${data.sessions}`} />
                  <StatCard label={m.label_laps()} value={`${data.laps}`} />
                  <StatCard label={m.label_tracks()} value={`${data.tracks}`} />
                  <StatCard label={m.label_cars()} value={`${data.cars}`} />
                  {timeSec > 0 && <StatCard label={m.home_stat_time_driven()} value={fmtTime(timeSec)} color="text-violet-400" />}
                </div>
              );
            })()}
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text/90-muted">{m.home_recent_laps()}</h2>
            <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseLap={onAnalyseLap} />
          </div>
        </>
      )}
    </div>
    </div>
  );
}
