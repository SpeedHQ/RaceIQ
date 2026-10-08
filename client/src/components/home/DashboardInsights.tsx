import { tryGetGame } from "@raceiq/shared/games/registry";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { Info, Trophy } from "lucide-react";
import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "../../lib/utc-date";
import { buildDashboardInsights, CONSISTENCY_DEVIATION_BOUNDS, type DashboardInsights, type DashboardTrackContext, type SessionTypeKind } from "./dashboard-insights";
import { resolveTrackDisplayName } from "@/lib/track-display-name";

export interface DashboardInsightsProps {
  laps: LapMeta[];
  sessions: SessionMeta[];
  gameId: GameId | null;
  trackNames?: Record<string, string>;
  carNames?: Record<string, string>;
  lapsLoading?: boolean;
  lapsError?: boolean;
  sessionsLoading?: boolean;
  sessionsError?: boolean;
}

function InsightInfo({ label, content }: { label: string; content: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" aria-label={label} className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-app-text-muted hover:text-app-text focus-visible:outline-2 focus-visible:outline-app-accent" />}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent role="tooltip">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const HISTOGRAM_LABELS = ["0", ...CONSISTENCY_DEVIATION_BOUNDS.map((bound) => bound.toFixed(1))];
const INSIGHT_PANEL_CLASS = "min-w-0 rounded-lg bg-app-surface-alt/30 p-3 @min-[640px]/workspace:h-84 @min-[640px]/workspace:overflow-y-auto";

const SESSION_LABELS: Record<SessionTypeKind, () => string> = {
  practice: () => m.home_insights_session_practice(),
  qualifying: () => m.home_insights_session_qualifying(),
  race: () => m.home_insights_session_race(),
};

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${remaining}`;
}

function contextLabel(context: DashboardTrackContext, trackNames: Record<string, string>, carNames: Record<string, string>): string {
  const track = resolveTrackDisplayName(context.gameId, {
    trackIdentity: context.trackIdentity,
    trackOrdinal: context.trackOrdinal,
  }, trackNames) ?? m.home_insights_unknown_track();
  const car = context.carIdentity === "car:unknown"
    ? m.home_insights_unknown_car()
    : context.carOrdinal != null
      ? carNames[`${context.gameId}:${context.carOrdinal}`]?.trim() || m.review_car_fallback({ ordinal: context.carOrdinal })
      : context.carIdentity.replace(/^car:(number|string):/, "");
  return `${track} · ${car}`;
}

function TrackDistribution({ insights, trackNames }: { insights: DashboardInsights; trackNames: Record<string, string> }) {
  const { totalSeconds, tracks, othersSeconds, othersShare, othersCount } = insights.trackDistribution;
  const slices = [
    ...tracks.map((track) => ({ key: track.key, seconds: track.seconds, share: track.share, track })),
    ...(othersCount > 0 ? [{ key: "others", seconds: othersSeconds, share: othersShare, track: null }] : []),
  ];
  const circumference = 2 * Math.PI * 38;
  let offset = 0;
  const segmentColors = ["var(--app-accent)", "var(--app-text-muted)", "var(--app-text-dim)", "var(--app-border-hover)", "var(--app-border)", "var(--app-progress-track)"];

  return (
    <section aria-labelledby="insights-track-distribution-title" className={INSIGHT_PANEL_CLASS}>
      <div className="flex items-center gap-1">
        <h2 id="insights-track-distribution-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_track_distribution_title()}</h2>
        <InsightInfo label={m.home_insights_track_distribution_title()} content={m.home_insights_track_distribution_note()} />
      </div>
      {totalSeconds <= 0 ? (
        <p className="mt-3 text-app-detail text-app-text-muted">{m.home_insights_track_distribution_empty()}</p>
      ) : (
        <div className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
          <div className="relative mx-auto size-28" role="img" aria-label={m.home_insights_total_hours({ hours: (totalSeconds / 3600).toFixed(1) })}>
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r="38" fill="none" stroke="var(--app-progress-track)" strokeWidth="12" />
              {slices.map((slice, index) => {
                const length = slice.share * circumference;
                const circle = <circle key={slice.key} cx="50" cy="50" r="38" fill="none" stroke={segmentColors[index % segmentColors.length]} strokeWidth="12" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />;
                offset += length;
                return circle;
              })}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="font-mono text-app-heading font-semibold tabular-nums text-app-text">{(totalSeconds / 3600).toFixed(1)} h</span>
              <span className="text-app-caption text-app-text-muted">{m.home_insights_total()}</span>
            </div>
          </div>
          <ul className="min-w-0 space-y-1.5">
            {slices.map((slice, index) => {
              const trackName = slice.track
                ? resolveTrackDisplayName(slice.track.gameId, {
                  trackIdentity: slice.track.trackIdentity,
                  trackOrdinal: slice.track.trackOrdinal,
                }, trackNames) ?? `${m.home_insights_unknown_track()} · ${tryGetGame(slice.track.gameId)?.displayName ?? slice.track.gameId}`
                : m.home_insights_other_tracks({ count: othersCount });
              return (
                <li key={slice.key} className="grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_2.25rem] items-center gap-1.5 text-app-detail">
                  <span className="size-2 rounded-full" style={{ backgroundColor: segmentColors[index % segmentColors.length] }} aria-hidden="true" />
                  <span className="truncate text-app-text-secondary" title={trackName}>{trackName}</span>
                  <span className="text-right font-mono tabular-nums text-app-text">{Math.round(slice.share * 100)}%</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function ConsistencyChart({ insights, loading, error }: {
  insights: DashboardInsights;
  loading: boolean;
  error: boolean;
}) {
  const { sessions, averageStandardDeviation, deviations } = insights.consistency;
  const labels = HISTOGRAM_LABELS;
  const maxCount = Math.max(0, ...deviations);
  const status = loading ? m.home_insights_analytics_loading() : error ? m.home_insights_analytics_error() : null;

  return (
    <section aria-labelledby="insights-consistency-title" className="min-w-0 shrink-0 border-t border-app-border pt-3">
      <div className="flex items-center gap-1">
        <h2 id="insights-consistency-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_consistency_title()}</h2>
        <InsightInfo label={m.home_insights_consistency_title()} content={m.home_insights_consistency_note()} />
      </div>
      {status ? (
        <p className={`mt-3 text-app-detail ${error ? "text-status-danger" : "text-app-text-muted"}`} role={error ? "alert" : "status"}>{status}</p>
      ) : averageStandardDeviation == null ? (
        <div className="mt-3">
          <p className="font-mono text-app-heading text-app-text-muted">—</p>
          <p className="mt-1 text-app-detail text-app-text-muted">{m.home_insights_consistency_insufficient()}</p>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-baseline justify-between gap-2">
            <p className="font-mono text-app-heading font-semibold tabular-nums text-app-text">±{averageStandardDeviation.toFixed(2)} s</p>
            <p className="text-app-caption tabular-nums text-app-text-muted">{m.home_insights_sample_count({ count: sessions })}</p>
          </div>
          <figure className="mt-3" aria-label={m.home_insights_deviation_bins_label()}>
            <div className="grid h-20 grid-cols-10 items-end gap-1 border-b border-app-border" aria-hidden="true">
              {deviations.map((count, index) => (
                <div key={labels[index]} className="flex h-full items-end">
                  <div className={`w-full rounded-t-sm ${index === 0 ? "bg-app-accent" : "bg-app-text-muted"}`} style={{ height: `${count === 0 ? 0 : Math.max(2, (count / maxCount) * 100)}%` }} />
                </div>
              ))}
            </div>
            <ul className="mt-1 grid grid-cols-10 gap-1 text-center text-app-micro leading-tight text-app-text-muted">
              {deviations.map((count, index) => {
                const interval = index === labels.length - 1 ? `≥${labels[index]} s` : `${labels[index]}–<${labels[index + 1]} s`;
                return <li key={labels[index]} title={interval}><span className="sr-only">{interval}: </span><span className="block" aria-hidden="true">{index === labels.length - 1 ? `≥${labels[index]}` : labels[index]}</span><span className="font-mono tabular-nums text-app-text-secondary">{count}</span></li>;
              })}
            </ul>
          </figure>
        </>
      )}
    </section>
  );
}
function TrackStats({ insights, trackContext, trackNames, carNames, loading, error }: {
  insights: DashboardInsights;
  trackContext: DashboardTrackContext | null;
  trackNames: Record<string, string>;
  carNames: Record<string, string>;
  loading: boolean;
  error: boolean;
}) {
  const analytics = insights.trackAnalytics;
  const status = loading ? m.home_insights_analytics_loading() : error ? m.home_insights_analytics_error() : null;
  const points = analytics?.trend ?? [];
  let minLap = Infinity;
  let maxLap = -Infinity;
  for (const point of points) {
    if (point.lapTime < minLap) minLap = point.lapTime;
    if (point.lapTime > maxLap) maxLap = point.lapTime;
  }
  const range = maxLap - minLap || 1;
  const startTime = points.length > 0 ? parseUtcTimestamp(points[0].createdAt).getTime() : 0;
  const endTime = points.length > 0 ? parseUtcTimestamp(points[points.length - 1].createdAt).getTime() : 0;
  const timeRange = endTime - startTime;
  const coordinates = points.map((point) => {
    const pointTime = parseUtcTimestamp(point.createdAt).getTime();
    const x = timeRange <= 0 ? 160 : 8 + ((pointTime - startTime) / timeRange) * 304;
    const y = 94 - ((point.lapTime - minLap) / range) * 82;
    return `${x},${y}`;
  });
  const contextDescription = trackContext ? contextLabel(trackContext, trackNames, carNames) : "";

  return (
    <section aria-labelledby="insights-track-stats-title" className={INSIGHT_PANEL_CLASS}>
      <div className="flex items-center gap-1">
        <h2 id="insights-track-stats-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_track_stats_title()}</h2>
        <InsightInfo label={m.home_insights_track_stats_title()} content={m.home_insights_session_time_note()} />
      </div>
      {trackContext && <p className="mt-2 truncate text-app-caption text-app-text-muted" title={contextDescription}>{contextDescription}</p>}
      {status ? (
        <p className={`mt-3 text-app-detail ${error ? "text-status-danger" : "text-app-text-muted"}`} role={error ? "alert" : "status"}>{status}</p>
      ) : (
        <>
          {analytics && analytics.sessionTypeTotalSeconds > 0 ? (
            <>
              <ul className="mt-3 space-y-2" aria-label={m.home_insights_session_time_note()}>
                {analytics.sessionTypes.map(({ kind, seconds, share }) => (
                  <li key={kind} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.25rem] items-center gap-2 text-app-detail">
                    <span className="truncate text-app-text-secondary">{SESSION_LABELS[kind]()}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-app-progress-track" role="progressbar" aria-label={SESSION_LABELS[kind]()} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-valuetext={`${Math.round(share * 100)}% · ${formatDuration(seconds)}`}>
                      <span className="block h-full bg-app-accent" style={{ width: `${share * 100}%` }} />
                    </span>
                    <span className="text-right font-mono tabular-nums text-app-text">{Math.round(share * 100)}%</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-app-caption text-app-text-muted">{m.home_insights_session_time_total({ duration: formatDuration(analytics.sessionTypeTotalSeconds) })}</p>
            </>
          ) : (
            <p className="mt-3 text-app-detail text-app-text-muted">{m.home_insights_session_time_empty()}</p>
          )}
          <p className="mt-3 text-app-label font-semibold text-app-text">{m.home_insights_lap_trend()}</p>
          {points.length === 0 ? (
            <p className="mt-1 text-app-detail text-app-text-muted">{m.home_insights_lap_trend_empty()}</p>
          ) : (
            <figure className="mt-1" role="img" aria-label={m.home_insights_lap_trend_description({ count: points.length })}>
              <div className="flex items-center justify-between font-mono text-app-caption tabular-nums text-app-text-muted">
                <span>{formatLapTime(maxLap)}</span><span>{formatLapTime(minLap)}</span>
              </div>
              <svg viewBox="0 0 320 104" className="mt-1 h-20 w-full" aria-hidden="true" preserveAspectRatio="none">
                {[20, 60, 100].map((y) => <line key={y} x1="0" y1={y} x2="320" y2={y} stroke="var(--app-border)" strokeWidth="1" />)}
                {coordinates.length > 1 && <polyline points={coordinates.join(" ")} fill="none" stroke="var(--app-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
                {coordinates.map((coordinate, index) => {
                  const [cx, cy] = coordinate.split(",");
                  return <circle key={`${points[index].createdAt}-${index}`} cx={cx} cy={cy} r="2.3" fill="var(--app-accent)" />;
                })}
              </svg>
              <figcaption className="flex justify-between text-app-caption text-app-text-muted">
                <span>{parseUtcTimestamp(points[0].createdAt).toLocaleDateString(getLocale(), { month: "short" })}</span>
                <span>{parseUtcTimestamp(points[points.length - 1].createdAt).toLocaleDateString(getLocale(), { month: "short" })} · {formatLapTime(points[points.length - 1].lapTime)}</span>
              </figcaption>
              <ul className="sr-only">
                {points.map((point, index) => <li key={`${point.createdAt}-${index}`}>{parseUtcTimestamp(point.createdAt).toLocaleDateString(getLocale())}: {formatLapTime(point.lapTime)}</li>)}
              </ul>
            </figure>
          )}
        </>
      )}
    </section>
  );
}

export function DashboardInsights({ laps, sessions, gameId, trackNames = {}, carNames = {}, lapsLoading = false, lapsError = false, sessionsLoading = false, sessionsError = false }: DashboardInsightsProps) {
  const insights = useMemo(() => buildDashboardInsights(laps, sessions, gameId), [laps, sessions, gameId]);
  const placements = [
    { label: m.home_insights_podiums_first(), count: insights.podiums.first },
    { label: m.home_insights_podiums_second(), count: insights.podiums.second },
    { label: m.home_insights_podiums_third(), count: insights.podiums.third },
  ];
  const maxOtherPositionCount = Math.max(0, ...insights.podiums.otherPositions.map(({ count }) => count));
  const totalRaces = insights.podiums.total + insights.podiums.otherPositions.reduce((total, { count }) => total + count, 0);

  return (
    <div className="grid grid-cols-1 gap-3 @min-[640px]/workspace:grid-cols-2 @min-[960px]/workspace:grid-cols-4">
      <div className={`${INSIGHT_PANEL_CLASS} flex flex-col gap-3`}>
        <section aria-labelledby="insights-clean-title" className="min-w-0 shrink-0">
          <div className="flex items-center gap-1">
            <h2 id="insights-clean-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_clean_title()}</h2>
            <InsightInfo label={m.home_insights_clean_title()} content={insights.clean.rate == null ? m.home_insights_clean_empty() : m.home_insights_clean_rate()} />
          </div>
          {insights.clean.rate == null ? (
            <p className="mt-2 font-mono text-app-heading text-app-text-muted" title={m.home_insights_clean_empty()} aria-label={m.home_insights_clean_empty()}>—</p>
          ) : (
            <div className="mt-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-mono text-app-heading font-semibold tabular-nums text-app-text">{Math.round(insights.clean.rate * 100)}%</p>
                <p className="font-mono text-app-detail tabular-nums text-app-text-muted" title={m.home_insights_clean_rate()}><span className="sr-only">{m.home_insights_clean_rate()}: </span>{insights.clean.valid}/{insights.clean.total}</p>
              </div>
              <progress className="mt-2 block h-1 w-full accent-app-accent" value={insights.clean.rate * 100} max={100} aria-label={m.home_insights_clean_rate()} />
            </div>
          )}
        </section>
        <ConsistencyChart insights={insights} loading={lapsLoading} error={lapsError} />
      </div>

      <section aria-labelledby="insights-podiums-title" className={INSIGHT_PANEL_CLASS}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-1">
            <h2 id="insights-podiums-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_podiums_title()}</h2>
            <InsightInfo label={m.home_insights_podiums_title()} content={!insights.podiums.available ? m.home_insights_podiums_unavailable() : insights.podiums.otherPositions.length === 0 ? `${m.home_insights_podiums_description()} ${m.home_insights_other_positions_empty()}` : m.home_insights_podiums_description()} />
          </div>
          <span className="text-app-detail tabular-nums text-app-text-muted">{m.home_insights_podiums_races({ total: !sessionsLoading && !sessionsError && insights.podiums.available ? totalRaces : "—" })}</span>
        </div>
        <ul className="mt-2 grid grid-cols-3 gap-2" aria-label={m.home_insights_podiums_description()}>
          {placements.map(({ label, count }) => (
            <li key={label} className="min-w-0">
              <span className="block text-app-label text-app-text-muted">{label}</span>
              <span className="mt-1 flex items-center gap-2">
                <Trophy className="size-4 shrink-0 text-app-text-secondary" aria-hidden="true" />
                <span className="font-mono text-app-heading font-semibold tabular-nums text-app-text">{!sessionsLoading && !sessionsError && insights.podiums.available ? count : "—"}</span>
              </span>
            </li>
          ))}
        </ul>
        {sessionsLoading ? (
          <p className="mt-2 text-app-detail text-app-text-muted" role="status">{m.home_insights_podiums_loading()}</p>
        ) : sessionsError ? (
          <p className="mt-2 text-app-detail text-status-danger" role="alert">{m.home_insights_podiums_error()}</p>
        ) : !insights.podiums.available ? null : (
          <div className="mt-2">
            <p className="font-mono text-app-detail tabular-nums text-app-text-muted">{m.home_insights_podiums_total({ total: insights.podiums.total })}</p>
            <figure className="mt-3" aria-label={m.home_insights_other_positions_label()}>
              {insights.podiums.otherPositions.length === 0 ? (
                <figcaption className="sr-only">{m.home_insights_other_positions_empty()}</figcaption>
              ) : (
                <>
                  <figcaption className="sr-only">{m.home_insights_other_positions_label()}</figcaption>
                  <ul className="space-y-1.5" aria-label={m.home_insights_other_positions_label()}>
                    {insights.podiums.otherPositions.map(({ position, count }) => (
                      <li key={position} className="grid grid-cols-[2.5rem_1fr_1.5rem] items-center gap-2 text-app-detail">
                        <span className="font-mono tabular-nums text-app-text-secondary">P{position}</span>
                        <span className="h-1 overflow-hidden rounded-full bg-app-progress-track" aria-hidden="true"><span className="block h-full bg-app-accent" style={{ width: `${(count / maxOtherPositionCount) * 100}%` }} /></span>
                        <span className="text-right font-mono tabular-nums text-app-text">{count}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </figure>
          </div>
        )}
      </section>

      <TrackDistribution insights={insights} trackNames={trackNames} />
      <TrackStats insights={insights} trackContext={insights.trackContext} trackNames={trackNames} carNames={carNames} loading={lapsLoading} error={lapsError} />
    </div>
  );
}
