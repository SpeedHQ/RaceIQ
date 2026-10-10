import type { GameId } from "@raceiq/shared/games/ids";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { getLMUCar, resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { useSettings } from "@/hooks/settings";
import type { DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";
import { Link, useNavigate } from "@tanstack/react-router";
import { Info, Trophy } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { useTrackOutline } from "@/hooks/track-queries";
import { getLocale } from "@/paraglide/runtime";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyStateOverlay } from "@/components/ui/empty-state-overlay";
import { dashboardInsights, type DashboardInsights as DashboardInsightsData, type SessionTypeKind } from "./dashboard-insights";
import { resolveTrackDisplayName } from "@/lib/track-display-name";
import type { FavouriteInsight } from "./dashboard-insights";
import { formatDrivenTime } from "./Stats";
import type { PeriodStats } from "./types";
import { trackRoutePath } from "@/lib/track-routes";
import { piClass } from "@/components/forza/PiBadge";


type PeriodSummary = Pick<PeriodStats["year"], "laps" | "tracks" | "cars" | "sessions" | "totalTime">;

export interface DashboardInsightsProps {
  response: DashboardResponse | undefined;
  gameId: GameId | null;
  periodStart: number;
  trackNames?: Record<string, string>;
  periodSummary?: PeriodSummary;
  lapsLoading?: boolean;
  lapsError?: boolean;
  sessionsLoading?: boolean;
  sessionsError?: boolean;
  carNames?: Record<string, string>;
  latestSession?: ReactNode;
}

function FavouritePanel({ title, insight, kind, trackNames, carNames, gameId, loading, error, sessionsLoading, sessionsError, imperial }: {
  title: string;
  insight: FavouriteInsight | null;
  kind: "track" | "car";
  trackNames: Record<string, string>;
  carNames: Record<string, string>;
  gameId: GameId | null;
  loading: boolean;
  error: boolean;
  sessionsLoading: boolean;
  sessionsError: boolean;
  imperial: boolean;
}) {
  const navigate = useNavigate();
  const contextGameId = insight?.gameId ?? gameId;
  const masked = loading && !error;
  const unavailable = loading || error;
  const game = contextGameId ? tryGetGame(contextGameId) : null;
  const identity = insight?.identity;
  const suppliedCarName = !insight || kind !== "car" ? undefined
    : (carNames[`${insight.gameId}:${identity}`] ?? (insight.ordinal != null ? carNames[`${insight.gameId}:${insight.ordinal}`] : undefined))?.trim();
  const carOrdinal = !insight || kind !== "car" ? null : typeof identity === "number" ? identity : insight.ordinal ?? null;
  const carName = suppliedCarName || (insight && carOrdinal != null && carOrdinal >= 0 ? game?.getCarName(carOrdinal) : undefined)
    || (insight?.gameId === "lmu" && typeof identity === "string" ? getLMUCar(identity)?.name : undefined);
  const trackOrdinal = kind === "track" && insight
    ? insight.ordinal
      ?? (typeof identity === "string" ? game?.getTrackOrdinalByName?.(identity) : undefined)
      ?? (typeof identity === "number" && identity >= 0 ? identity : undefined)
    : undefined;
  const name = !insight ? null : kind === "track"
    ? resolveTrackDisplayName(insight.gameId, { trackId: identity, trackOrdinal }, trackNames)
    : carName;
  const trackIdentity = kind === "track" && !unavailable ? trackOrdinal ?? identity : undefined;
  const { data: outlineData } = useTrackOutline(trackIdentity, contextGameId);
  const track = useMemo(() => {
    const points = (Array.isArray(outlineData) ? outlineData : outlineData?.points ?? [])
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (points.length < 3) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    if (maxX <= minX || maxZ <= minZ) return null;
    const padding = Math.max(maxX - minX, maxZ - minZ) * 0.06;
    return {
      points: points.map((point) => `${point.x},${point.z}`).join(" "),
      viewBox: `${minX - padding} ${minZ - padding} ${maxX - minX + padding * 2} ${maxZ - minZ + padding * 2}`,
      transform: !Array.isArray(outlineData) && outlineData?.flipX ? `translate(${minX + maxX},0) scale(-1,1)` : undefined,
    };
  }, [outlineData]);
  const { data: cars } = useQuery<{ id?: string | number | null; ordinal?: number | null; class?: string; imageUrl?: string | null; specs?: { imageUrl?: string | null; pi?: number } | null }[]>({
    queryKey: ["cars", contextGameId],
    queryFn: async () => {
      if (contextGameId === "acc") {
        const catalog = await rpcJson<{ id: number; class: string }[]>(await client.api.acc.cars.$get());
        return catalog.map((car) => ({ id: car.id, class: car.class, imageUrl: `/car-images/acc-${car.id}.jpg` }));
      }
      if (contextGameId === "ac-evo") {
        return rpcJson<{ ordinal: number; class: string }[]>(await client.api["ac-evo"].cars.$get());
      }
      if (!contextGameId) return [];
      return rpcJson(await client.api.cars.$get({}, { headers: { "X-Game-Id": contextGameId } }));
    },
    enabled: kind === "car" && !!insight && !unavailable,
    staleTime: Infinity,
  });
  const car = kind === "car" && insight
    ? cars?.find((candidate) => String(candidate.id) === String(identity) || (insight.ordinal != null && candidate.ordinal === insight.ordinal))
    : undefined;
  const carImageUrl = car?.imageUrl || car?.specs?.imageUrl || undefined;
  const carClass = car?.class?.trim() || (contextGameId === "fm-2023" && car?.specs?.pi != null && car.specs.pi > 0 ? piClass(car.specs.pi) : undefined);
  const unknown = kind === "track" ? m.home_insights_unknown_track() : m.home_insights_unknown_car();
  const distance = insight?.distanceMeters == null ? "—" : imperial
    ? `${(insight.distanceMeters / 1609.344).toFixed(1)} mi`
    : `${(insight.distanceMeters / 1000).toFixed(1)} km`;
  const trackKey = insight?.gameId === "lmu"
    ? typeof identity === "string" ? resolveLMUTrack(identity)?.id : undefined
    : trackOrdinal;
  const trackHref = kind === "track" && !unavailable && insight && trackKey != null
    ? trackRoutePath(insight.gameId, trackKey)
    : null;
  return <section aria-busy={loading || sessionsLoading} aria-labelledby={`insights-favourite-${kind}-title`} onClick={trackHref ? (event) => { if ((event.target as HTMLElement).closest("button,a")) return; void navigate({ to: trackHref as never }); } : undefined} onKeyDown={trackHref ? (event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void navigate({ to: trackHref as never }); } } : undefined} role={trackHref ? "link" : undefined} tabIndex={trackHref ? 0 : undefined} className={`dashboard-hover-panel favourite-panel @container/favourite relative isolate flex h-[320px] min-w-0 flex-col rounded-xl border border-app-border bg-app-surface-alt/30 p-4 @3xl/workspace:h-auto @3xl/workspace:min-h-0 @3xl/workspace:p-3 ${trackHref ? "cursor-pointer" : ""} ${trackHref ? "focus-visible:outline-2 focus-visible:outline-app-accent" : ""}`}>
    <div className="flex min-h-6 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-1"><h2 id={`insights-favourite-${kind}-title`} className="text-app-heading font-semibold text-app-text">{title}</h2><InsightInfo label={title} content={m.home_insights_favourite_note()} /></div>
      <span title={contextGameId ? game?.displayName ?? contextGameId : undefined} className="shrink-0 rounded border border-app-accent/30 bg-app-accent/10 px-2 py-0.5 text-app-label font-semibold uppercase text-app-accent"><Skeleton loading={masked}>{unavailable ? "—" : contextGameId ?? "—"}</Skeleton></span>
    </div>
    <div className="mt-3 min-h-0 flex-1 @3xl/workspace:mt-2">
      <div className="relative">
        {kind === "track" && !unavailable && track && <svg viewBox={track.viewBox} aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-20 w-28 text-app-text @min-[440px]/favourite:h-full @min-[440px]/favourite:w-[28%]"><polyline points={track.points} transform={track.transform} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /></svg>}
        {kind === "car" && !unavailable && carImageUrl && <img key={carImageUrl} src={carImageUrl} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.style.display = "none"; }} className="pointer-events-none absolute -right-3 -top-3 h-28 w-2/3 object-contain object-right opacity-70 [mask-image:linear-gradient(to_right,transparent,black_35%)] @min-[360px]/favourite:opacity-100 @min-[440px]/favourite:right-0 @min-[440px]/favourite:top-0 @min-[440px]/favourite:h-full! @min-[440px]/favourite:w-[28%] @3xl/workspace:top-0! @3xl/workspace:h-10" />}
        <div className="relative mt-1 flex h-20 items-center @min-[440px]/favourite:h-16 @3xl/workspace:h-8">
          {trackHref
            ? <Link to={trackHref as never} className="relative min-w-0 max-w-[65%] break-words text-app-heading font-semibold leading-tight text-app-text focus-visible:outline-2 focus-visible:outline-app-accent">{name ?? unknown}</Link>
            : <Skeleton loading={masked} className="relative min-w-0 max-w-[65%] break-words text-app-heading font-semibold leading-tight text-app-text">{unavailable ? "—" : name ?? (insight ? unknown : "—")}</Skeleton>}
        </div>
        <dl className="mt-2 grid min-h-14 shrink-0 grid-cols-2 gap-2 rounded-lg border border-app-border p-2 text-app-detail [&>div]:grid [&>div]:min-w-0 [&>div]:grid-rows-[1fr_auto] [&>div]:content-start [&>div]:gap-0.5 [&>div]:whitespace-normal [&_dt]:min-w-0 [&_dt]:text-app-label [&_dt>button]:size-4 @min-[440px]/favourite:flex @min-[440px]/favourite:flex-wrap @min-[440px]/favourite:w-[70%] @min-[440px]/favourite:gap-y-1.5 @min-[440px]/favourite:[&>div]:flex @min-[440px]/favourite:[&>div]:flex-row @min-[440px]/favourite:[&>div]:items-baseline @min-[440px]/favourite:[&>div]:gap-1.5">
          <SummaryMetric label={m.home_stat_time_driven()} value={unavailable || !insight ? "—" : formatDrivenTime(insight.seconds)} accent loading={masked} />
          <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="inline-flex items-center gap-1 text-app-text-muted">{m.home_insights_estimated_distance()}<InsightInfo label={m.home_insights_estimated_distance()} content={insight ? m.home_insights_favourite_distance_note({ covered: insight.distanceLaps, laps: insight.laps }) : m.home_insights_favourite_note()} /></dt>
            <dd className="font-mono tabular-nums text-app-text"><Skeleton loading={masked}>{unavailable || !insight ? "—" : distance}</Skeleton></dd>
          </div>
          <SummaryMetric label={m.label_sessions()} value={unavailable || !insight || sessionsLoading || sessionsError ? "—" : insight.sessions} loading={sessionsLoading && !sessionsError} />
          <SummaryMetric label={m.label_laps()} value={unavailable || !insight ? "—" : insight.laps} loading={masked} />
          <SummaryMetric label={m.home_insights_podiums_title()} value={unavailable || !insight || sessionsLoading || sessionsError || insight.podiums == null ? "—" : insight.podiums} loading={sessionsLoading && !sessionsError} />
          {kind === "car" && <SummaryMetric label={m.track_detail_class()} value={unavailable ? "—" : carClass ?? "—"} loading={masked} />}
        </dl>
      </div>
      {(loading || error || !insight || sessionsLoading || sessionsError) && <p className="sr-only" role={error || sessionsError ? "alert" : "status"}>{error || sessionsError ? m.home_insights_analytics_error() : loading || sessionsLoading ? m.home_insights_analytics_loading() : m.home_insights_favourite_empty()}</p>}
    </div>
    {!loading && !error && !insight && <EmptyStateOverlay />}
  </section>;
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

const HISTOGRAM_BINS = [
  { label: "<0.1", interval: "<0.1 s" },
  { label: "0.1", interval: "0.1–<0.2 s" },
  { label: "0.2", interval: "0.2–<0.5 s" },
  { label: "0.5", interval: "0.5–<1 s" },
  { label: "1", interval: "1–<2 s" },
  { label: "2", interval: "2–5 s (inclusive)" },
  { label: ">5", interval: ">5 s" },
] as const;
const INSIGHT_PANEL_BASE_CLASS = "flex min-w-0 flex-1 flex-col rounded-lg border border-app-border bg-app-surface-alt/30";
const INSIGHT_PANEL_CLASS = `${INSIGHT_PANEL_BASE_CLASS} h-[216px] p-3`;
const SPARKLINE_PANEL_CLASS = `${INSIGHT_PANEL_BASE_CLASS} h-[160px] p-2`;

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
function SummaryMetric({ label, value, accent = false, loading = false }: { label: string; value: string | number; accent?: boolean; loading?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap text-app-detail">
      <dt className="text-app-text-muted">{label}</dt>
      <dd className={`font-mono tabular-nums ${accent ? "text-app-accent" : "text-app-text"}`}><Skeleton loading={loading}>{value}</Skeleton></dd>
    </div>
  );
}



function TrackDistribution({ insights, trackNames, periodSummary, loading, error }: { insights: DashboardInsightsData; trackNames: Record<string, string>; periodSummary?: PeriodSummary; loading: boolean; error: boolean }) {
  const { totalSeconds, tracks, othersShare, othersCount } = insights.trackDistribution;
  const unavailable = loading || error || totalSeconds <= 0;
  const slices = [
    ...tracks.map((track) => ({ key: track.key, share: track.share, track })),
    ...(othersCount > 0 ? [{ key: "others", share: othersShare, track: null }] : []),
  ];
  const circumference = 2 * Math.PI * 38;
  let offset = 0;
  const colors = ["var(--app-accent)", "var(--app-text-muted)", "var(--app-text-dim)", "var(--app-border-hover)", "var(--app-border)", "var(--app-progress-track)"];
  return (
    <section aria-busy={loading} aria-labelledby="insights-track-distribution-title" className={INSIGHT_PANEL_CLASS}>
      <div className="flex min-h-10 shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          <h2 id="insights-track-distribution-title" className="text-app-heading font-semibold text-app-text">{m.home_insights_track_distribution_title()}</h2>
          <InsightInfo label={m.home_insights_track_distribution_title()} content={m.home_insights_track_distribution_note()} />
        </div>
        {periodSummary && <dl className="flex flex-wrap gap-x-3 gap-y-1">
          <SummaryMetric label={m.label_tracks()} value={unavailable ? "—" : periodSummary.tracks} loading={loading && !error} />
          <SummaryMetric label={m.label_cars()} value={unavailable ? "—" : periodSummary.cars} loading={loading && !error} />
        </dl>}
      </div>
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
        <div className="relative mx-auto size-28" role="img" aria-label={unavailable ? m.home_insights_no_data() : m.home_insights_total_hours({ hours: (totalSeconds / 3600).toFixed(1) })}>
          <Skeleton loading={loading && !error} shape="circle" className="absolute inset-0">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r="38" fill="none" stroke="var(--app-progress-track)" strokeWidth="12" />
              {!unavailable && slices.map((slice, index) => {
                const length = slice.share * circumference;
                const circle = <circle key={slice.key} cx="50" cy="50" r="38" fill="none" stroke={colors[index % colors.length]} strokeWidth="12" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />;
                offset += length;
                return circle;
              })}
            </svg>
          </Skeleton>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className={unavailable ? "text-app-detail text-app-text-muted" : "font-mono text-app-heading font-semibold tabular-nums text-app-text"}><Skeleton loading={loading && !error}>{unavailable ? "—" : `${(totalSeconds / 3600).toFixed(1)} h`}</Skeleton></span>
            <span className="text-app-caption text-app-text-muted">{m.home_insights_total()}</span>
          </div>
          {!loading && !error && totalSeconds <= 0 && <EmptyStateOverlay />}
        </div>
        <ul className="min-w-0 space-y-1">
          {Array.from({ length: 6 }, (_, index) => {
            const slice = unavailable ? undefined : slices[index];
            const name = !slice ? "—" : slice.track
              ? resolveTrackDisplayName(slice.track.gameId, { trackIdentity: slice.track.trackIdentity, trackOrdinal: slice.track.trackOrdinal }, trackNames) ?? m.home_insights_unknown_track()
              : m.home_insights_other_tracks({ count: othersCount });
            return <li key={index} className="grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_2.25rem] items-center gap-1.5 text-app-detail">
              <span className="size-2 rounded-full" style={{ backgroundColor: slice ? colors[index % colors.length] : "var(--app-progress-track)" }} aria-hidden="true" />
              <span className="truncate text-app-text-secondary" title={name}>{name}</span>
              <Skeleton loading={loading && !error} className="text-right font-mono tabular-nums text-app-text">{slice ? `${Math.round(slice.share * 100)}%` : "—"}</Skeleton>
            </li>;
          })}
        </ul>
      </div>
      {(loading || error) && <p className="sr-only" role={error ? "alert" : "status"}>{error ? m.home_insights_analytics_error() : m.home_insights_analytics_loading()}</p>}
    </section>
  );
}

function PercentageTrendChart({ trend, label, periodStart, periodEnd, status = null }: {
  trend: readonly { timestamp: number; rate: number; total: number; valid: number }[];
  label: string;
  periodStart: number;
  periodEnd: number;
  status?: { text: string; error: boolean } | null;
}) {
  const span = periodEnd - periodStart;
  const plottedTrend = trend;
  const x = (time: number) => span <= 0 ? 160 : 8 + (time - periodStart) / span * 304;
  const y = (rate: number) => 88 - rate * 76;
  const sameDay = new Date(periodStart).toDateString() === new Date(periodEnd).toDateString();
  const dates = new Intl.DateTimeFormat(getLocale(), sameDay ? { hour: "numeric", minute: "2-digit" } : {
    month: "short",
    day: "numeric",
    ...(new Date(periodStart).getFullYear() !== new Date(periodEnd).getFullYear() ? { year: "numeric" } as const : {}),
  });
  const times = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" });
  return (
    <Skeleton loading={status != null && !status.error} shape="chart" className="mt-1 min-h-0 w-full flex-1">
      <svg viewBox="0 0 320 112" preserveAspectRatio="none" className="block h-full w-full" role="group" aria-label={label}>
        <title>{label}</title>
        {plottedTrend.length > 0 && <polyline points={plottedTrend.map((point) => `${x(point.timestamp)},${y(point.rate)}`).join(" ")} fill="none" stroke="var(--app-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {plottedTrend.map((point, index) => {
          const pointLabel = `${times.format(point.timestamp)} · ${Math.round(point.rate * 100)}% · ${point.valid}/${point.total}`;
          return <circle key={index} cx={x(point.timestamp)} cy={y(point.rate)} r={plottedTrend.length === 1 ? 3 : 2} fill="var(--app-accent)" role="img" aria-label={pointLabel} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-app-accent"><title>{pointLabel}</title></circle>;
        })}
        <text x={span <= 0 ? 160 : 8} y="106" textAnchor={span <= 0 ? "middle" : "start"} fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(periodStart)}</text>
        {span > 0 && <text x="312" y="106" textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(periodEnd)}</text>}
      </svg>
      {status && <p className={`absolute inset-0 grid place-items-center text-app-detail ${status.error ? "text-status-danger" : "text-app-text-muted"}`}>{status.text}</p>}
      {!status && trend.length === 0 && <EmptyStateOverlay />}
    </Skeleton>
  );
}

const PODIUM_COLORS = ["var(--app-podium-gold)", "var(--app-podium-silver)", "var(--app-podium-bronze)"] as const;

function PodiumTrendChart({ trend, periodStart, periodEnd }: { trend: DashboardInsightsData["podiums"]["trend"]; periodStart: number; periodEnd: number }) {
  const first = trend[0];
  const last = trend[trend.length - 1];
  const width = Math.max(320, trend.length * 8 + 16);
  const step = (width - 16) / Math.max(trend.length, 1);
  const maxCount = Math.max(2, Math.ceil(Math.max(0, ...trend.map((point) => point.podiums)) / 2) * 2);
  const dates = new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", year: new Date(first?.timestamp ?? periodStart).getFullYear() !== new Date(last?.timestamp ?? periodEnd).getFullYear() ? "numeric" : undefined });
  const times = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" });
  return <div className="h-full overflow-x-auto">
    <svg viewBox={`0 0 ${width} 112`} preserveAspectRatio="none" className="block h-full w-full" style={{ minWidth: width > 320 ? width : undefined }} role="group" aria-label={m.home_insights_podiums_description()}>
      <title>{m.home_insights_podiums_description()}</title>
      {trend.map((point, index) => {
        const barWidth = Math.min(step * 0.8, 16);
        const x = 8 + index * step + (step - barWidth) / 2;
        const height = point.podiums / maxCount * 76;
        const label = `${times.format(point.timestamp)} · ${m.home_insights_podiums_total({ total: point.podiums })}`;
        return <g key={point.timestamp} role="img" aria-label={label} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-app-accent"><title>{label}</title><rect x={x} y="12" width={barWidth} height="76" fill="var(--app-progress-track)" /><rect x={x} y={88 - height} width={barWidth} height={height} fill="var(--app-accent)" /></g>;
      })}
      <text x="8" y="106" fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(first?.timestamp ?? periodStart)}</text>
      {(trend.length === 0 || trend.length > 1) && <text x={width - 8} y="106" textAnchor="end" fill="var(--app-text-muted)" className="font-mono text-app-caption">{dates.format(last?.timestamp ?? periodEnd)}</text>}
    </svg>
  </div>;
}

function ConsistencyChart({ insights, loading, error }: {
  insights: DashboardInsightsData;
  loading: boolean;
  error: boolean;
}) {
  const { sessions, averageStandardDeviation, deviations } = insights.consistency;
  const step = (320 - 16) / HISTOGRAM_BINS.length;
  const maxCount = Math.max(2, Math.ceil(Math.max(0, ...deviations) / 2) * 2);
  const status = loading ? m.home_insights_analytics_loading() : error ? m.home_insights_analytics_error() : null;

  return (
    <section aria-busy={loading} aria-labelledby="insights-consistency-title" className={SPARKLINE_PANEL_CLASS}>
      <div className="flex min-h-6 shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          <h2 id="insights-consistency-title" className="text-app-heading font-semibold text-app-text">{m.home_insights_consistency_title()}</h2>
          <InsightInfo label={m.home_insights_consistency_title()} content={m.home_insights_consistency_note()} />
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className={`whitespace-nowrap font-mono text-app-heading font-semibold tabular-nums ${loading || error || averageStandardDeviation == null ? "text-app-text-muted" : "text-app-text"}`}><Skeleton loading={loading && !error}>{loading || error || averageStandardDeviation == null ? "—" : `±${averageStandardDeviation.toFixed(2)} s`}</Skeleton></p>
          <p className="whitespace-nowrap text-app-compact tabular-nums text-app-text-muted"><Skeleton loading={loading && !error}>{loading || error || averageStandardDeviation == null ? "—" : m.home_insights_sample_count({ count: sessions })}</Skeleton></p>
        </div>
      </div>
      <Skeleton loading={loading && !error} shape="chart" className="relative mt-1 min-h-0 flex-1">
        {averageStandardDeviation == null || status ? (
          <>
            <svg viewBox="0 0 320 112" preserveAspectRatio="none" className="absolute inset-0 block h-full w-full" aria-hidden="true">
              {HISTOGRAM_BINS.map((_, visualIndex) => {
                const bin = HISTOGRAM_BINS[HISTOGRAM_BINS.length - 1 - visualIndex]!;
                const x = 8 + visualIndex * step;
                const width = step - 4;
                return <g key={bin.label}>
                  <text x={x + width / 2} y="100" textAnchor="middle" fill="var(--app-text-muted)" className="font-mono text-app-caption">{bin.label}<title>{bin.interval}</title></text>
                  <text x={x + width / 2} y="111" textAnchor="middle" fill="var(--app-text-muted)" className="font-mono text-app-caption">s<title>{bin.interval}</title></text>
                </g>;
              })}
            </svg>
            {error && <p className="sr-only text-status-danger">{m.home_insights_analytics_error()}</p>}
          </>
        ) : (
          <svg viewBox="0 0 320 112" preserveAspectRatio="none" className="block h-full w-full" role="group" aria-label={m.home_insights_deviation_bins_label()}>
            <title>{m.home_insights_deviation_bins_label()}</title>
            {HISTOGRAM_BINS.map((_, visualIndex) => {
              const index = HISTOGRAM_BINS.length - 1 - visualIndex;
              const bin = HISTOGRAM_BINS[index]!;
              const count = deviations[index] ?? 0;
              const x = 8 + visualIndex * step;
              const width = step - 4;
              const height = count / maxCount * 76;
              return (
                <g key={bin.label} role="img" aria-label={`${bin.interval}: ${count}`} tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-app-accent">
                  <title>{bin.interval}: {count}</title>
                  <rect x={x} y={88 - height} width={width} height={height} rx="2" fill={index === 0 ? "var(--app-accent)" : "var(--app-text-muted)"} />
                  <text x={x + width / 2} y="100" textAnchor="middle" fill="var(--app-text-muted)" className="font-mono text-app-caption">{bin.label}<title>{bin.interval}: {count}</title></text>
                  <text x={x + width / 2} y="111" textAnchor="middle" fill="var(--app-text-muted)" className="font-mono text-app-caption">s<title>{bin.interval}: {count}</title></text>
                </g>
              );
            })}
          </svg>
        )}
        {error && <p aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center text-app-detail text-status-danger">{m.home_insights_analytics_error()}</p>}
        {averageStandardDeviation == null && !loading && !error && <EmptyStateOverlay />}
      </Skeleton>
      {(loading || error) && <p className="sr-only" role={error ? "alert" : "status"}>{status}</p>}
    </section>
  );
}
function SessionStats({ insights, loading, error, periodSummary }: {
  insights: DashboardInsightsData;
  loading: boolean;
  error: boolean;
  periodSummary?: PeriodSummary;
}) {
  const stats = insights.sessionStats;
  const unavailable = loading || error || stats.sessionTypeTotalSeconds <= 0;
  const colors: Record<SessionTypeKind, string> = {
    practice: "var(--app-accent)",
    qualifying: "var(--app-text-muted)",
    race: "var(--app-text-dim)",
  };
  const slices = [
    ...stats.sessionTypes.map(({ kind, seconds, share }) => ({
      key: kind, label: SESSION_LABELS[kind](), seconds, share, color: colors[kind],
    })),
    { key: "other", label: m.home_insights_session_unclassified(), seconds: stats.unclassifiedSeconds, share: stats.unclassifiedShare, color: "var(--app-border-hover)" },
  ];
  const circumference = 2 * Math.PI * 38;
  let offset = 0;
  return (
    <section aria-busy={loading} aria-labelledby="insights-session-stats-title" className={INSIGHT_PANEL_CLASS}>
      <div className="flex min-h-10 shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          <h2 id="insights-session-stats-title" className="text-app-heading font-semibold text-app-text">{m.home_insights_session_stats_title()}</h2>
          <InsightInfo label={m.home_insights_session_stats_title()} content={m.home_insights_session_time_note()} />
        </div>
        {periodSummary && (
          <dl className="flex flex-wrap gap-x-3 gap-y-1">
            <SummaryMetric label={m.label_sessions()} value={unavailable ? "—" : periodSummary.sessions} loading={loading && !error} />
            <SummaryMetric label={m.home_stat_time_driven()} value={unavailable ? "—" : formatDrivenTime(periodSummary.totalTime)} accent loading={loading && !error} />
          </dl>
        )}
      </div>
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
            <div className="relative mx-auto size-28" role="img" aria-label={unavailable ? m.home_insights_no_data() : m.home_insights_session_time_total({ duration: formatDuration(stats.sessionTypeTotalSeconds) })}>
              <Skeleton loading={loading && !error} shape="circle" className="absolute inset-0">
                <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
                  <circle cx="50" cy="50" r="38" fill="none" stroke="var(--app-progress-track)" strokeWidth="12" />
                  {!unavailable && slices.map((slice) => {
                    const length = slice.share * circumference;
                    const circle = <circle key={slice.key} cx="50" cy="50" r="38" fill="none" stroke={slice.color} strokeWidth="12" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />;
                    offset += length;
                    return circle;
                  })}
                </svg>
              </Skeleton>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className={unavailable ? "text-app-detail text-app-text-muted" : "font-mono text-app-heading font-semibold tabular-nums text-app-text"}><Skeleton loading={loading && !error}>{unavailable ? "—" : `${(stats.sessionTypeTotalSeconds / 3600).toFixed(1)} h`}</Skeleton></span>
                <span className="text-app-caption text-app-text-muted">{m.home_insights_total()}</span>
              </div>
              {!loading && !error && stats.sessionTypeTotalSeconds <= 0 && <EmptyStateOverlay />}
            </div>
            <ul className="min-w-0 space-y-1" aria-label={m.home_insights_session_time_note()}>
              {slices.map((slice) => (
                <li key={slice.key} className="grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-1.5 text-app-detail">
                  <span className="size-2 rounded-full" style={{ backgroundColor: unavailable ? "var(--app-progress-track)" : slice.color }} aria-hidden="true" />
                  <span className="truncate text-app-text-secondary" title={slice.label}>{slice.label}</span>
                  <span className="text-right font-mono tabular-nums text-app-text" title={unavailable ? undefined : m.home_insights_session_time_total({ duration: formatDuration(slice.seconds) })}><Skeleton loading={loading && !error}>{unavailable ? "—" : `${formatDuration(slice.seconds)} · ${Math.round(slice.share * 100)}%`}</Skeleton></span>
                </li>
              ))}
            </ul>
          </div>
      {(loading || error) && <p className="sr-only" role={error ? "alert" : "status"}>{error ? m.home_insights_analytics_error() : m.home_insights_analytics_loading()}</p>}
    </section>
  );
}

export function DashboardInsights({ response, gameId, periodStart, trackNames = {}, carNames = {}, latestSession, periodSummary, lapsLoading = false, lapsError = false, sessionsLoading = false, sessionsError = false }: DashboardInsightsProps) {
  const { displaySettings } = useSettings();
  const imperial = displaySettings.unit === "imperial";
  if (!response) return <div className="min-h-40 rounded-lg border border-app-border p-4 text-app-detail text-app-text-muted" role={lapsError ? "alert" : "status"} aria-busy={!lapsError}>{lapsError ? m.home_insights_analytics_error() : m.home_insights_analytics_loading()}</div>;
  const periodEnd = Date.parse(response.request.to);
  const insights = dashboardInsights(response);
  const podiumsKnown = insights.podiums.available;
  const placements = [
    { label: m.home_insights_podiums_first(), count: insights.podiums.first },
    { label: m.home_insights_podiums_second(), count: insights.podiums.second },
    { label: m.home_insights_podiums_third(), count: insights.podiums.third },
  ];
  const favouritesRow = (
    <div className="grid min-w-0 grid-cols-1 items-stretch gap-3 @3xl/workspace:grid-cols-2">
      {latestSession}
      <div className="grid min-w-0 grid-cols-1 gap-3 @3xl/workspace:grid-rows-[repeat(2,minmax(min-content,1fr))]">
        <FavouritePanel title={m.home_insights_favourite_track_title()} insight={insights.favouriteTrack} kind="track" trackNames={trackNames} carNames={carNames} gameId={gameId} loading={lapsLoading} error={lapsError} sessionsLoading={sessionsLoading} sessionsError={sessionsError} imperial={imperial} />
        <FavouritePanel title={m.home_insights_favourite_car_title()} insight={insights.favouriteCar} kind="car" trackNames={trackNames} carNames={carNames} gameId={gameId} loading={lapsLoading} error={lapsError} sessionsLoading={sessionsLoading} sessionsError={sessionsError} imperial={imperial} />
      </div>
    </div>
  );

  return (
    <div className="@container/insights min-w-0 space-y-4">
      {response.coverage.status !== "complete" && (
        <p role="status" className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-app-detail text-app-text-muted">
          {response.coverage.status === "pending"
            ? m.home_dashboard_coverage_pending({
                ready: response.coverage.readySessions,
                mine: response.coverage.mineSessions,
                pending: response.coverage.pendingSessions,
              })
            : m.home_dashboard_coverage_unavailable()}
        </p>
      )}
      {favouritesRow}
      <div className="grid grid-cols-1 items-stretch gap-3 @min-[560px]/insights:grid-cols-2 @min-[800px]/insights:grid-cols-3">
        <section aria-busy={lapsLoading} aria-labelledby="insights-clean-title" className={SPARKLINE_PANEL_CLASS}>
          <div className="flex min-h-6 shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-1">
              <h2 id="insights-clean-title" className="text-app-heading font-semibold text-app-text">{m.home_insights_clean_title()}</h2>
              <InsightInfo label={m.home_insights_clean_title()} content={insights.clean.rate == null ? m.home_insights_clean_empty() : m.home_insights_clean_rate()} />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="font-mono text-app-heading font-semibold tabular-nums text-app-text" title={m.home_insights_clean_rate()}><Skeleton loading={lapsLoading && !lapsError}>{lapsLoading || lapsError || insights.clean.rate == null ? "—" : `${Math.round(insights.clean.rate * 100)}%`}</Skeleton></p>
              <p className="font-mono text-app-detail tabular-nums text-app-text-muted" title={m.home_insights_clean_rate()}><Skeleton loading={lapsLoading && !lapsError}>{lapsLoading || lapsError || insights.clean.rate == null ? "— / —" : `${insights.clean.valid}/${insights.clean.total}`}</Skeleton></p>
              {periodSummary && <dl><SummaryMetric label={m.label_laps()} value={lapsLoading || lapsError || insights.clean.total === 0 ? "—" : periodSummary.laps} loading={lapsLoading && !lapsError} /></dl>}
            </div>
          </div>
          <PercentageTrendChart trend={lapsLoading || lapsError || insights.clean.rate == null ? [] : insights.clean.trend} label={m.home_insights_clean_rate()} periodStart={periodStart} periodEnd={periodEnd} status={lapsLoading || lapsError ? { text: lapsError ? m.home_insights_analytics_error() : m.home_insights_analytics_loading(), error: lapsError } : null} />
        </section>
      <div className="flex min-w-0 @min-[560px]/insights:col-span-2 @min-[560px]/insights:row-start-2 @min-[800px]/insights:col-span-1 @min-[800px]/insights:col-start-2 @min-[800px]/insights:row-start-1">
        <ConsistencyChart insights={insights} loading={lapsLoading} error={lapsError} />
      </div>

      <section aria-busy={sessionsLoading} aria-labelledby="insights-podiums-title" className={SPARKLINE_PANEL_CLASS}>
        <div className="flex min-h-6 shrink-0 flex-wrap items-start gap-x-3 gap-y-1">
          <div className="flex items-center gap-1">
            <h2 id="insights-podiums-title" className="text-app-heading font-semibold text-app-text">{m.home_insights_podiums_title()}</h2>
            <InsightInfo label={m.home_insights_podiums_title()} content={!podiumsKnown ? m.home_insights_podiums_unavailable() : m.home_insights_podiums_description()} />
          </div>
          <ul className="flex items-center gap-3" aria-label={m.home_insights_podiums_description()}>
            {placements.map(({ label, count }, index) => (
              <li key={label} className="flex items-center gap-1">
                <span className="sr-only">{label}</span>
                <Trophy className="size-4 shrink-0" style={{ color: PODIUM_COLORS[index] }} aria-hidden="true" />
                <span className="font-mono text-app-subtext font-semibold tabular-nums text-app-text"><Skeleton loading={sessionsLoading && !sessionsError}>{!sessionsLoading && !sessionsError && podiumsKnown ? count : "—"}</Skeleton></span>
              </li>
            ))}
          </ul>
          <span className="ml-auto text-app-detail tabular-nums text-app-text-muted"><Skeleton loading={sessionsLoading && !sessionsError}>{m.home_insights_podiums_total({ total: !sessionsLoading && !sessionsError && podiumsKnown ? insights.podiums.total : "—" })}</Skeleton></span>
        </div>
        <div className="mt-1 flex min-h-0 flex-1 flex-col">
          {sessionsLoading || sessionsError || !podiumsKnown ? (
            <Skeleton loading={sessionsLoading && !sessionsError} shape="chart" className="flex min-h-0 flex-1 items-center justify-center">
              <p className={`flex h-full items-center justify-center px-3 text-center text-app-detail ${sessionsError ? "text-status-danger" : "text-app-text-muted"}`} role={sessionsError ? "alert" : sessionsLoading ? "status" : undefined}>
                {sessionsError ? m.home_insights_podiums_error() : sessionsLoading ? m.home_insights_podiums_loading() : m.home_insights_podiums_unavailable()}
              </p>
            </Skeleton>
          ) : (
            <>
              <div className="min-h-0 flex-1">
                <PodiumTrendChart trend={insights.podiums.trend} periodStart={periodStart} periodEnd={periodEnd} />
              </div>
            </>
          )}
        </div>
      </section>

      <div className="grid min-w-0 grid-cols-1 items-stretch gap-3 @min-[560px]/insights:col-span-2 @min-[560px]/insights:grid-cols-2 @min-[800px]/insights:col-span-3">
      <div className="flex min-w-0">
        <TrackDistribution insights={insights} trackNames={trackNames} periodSummary={periodSummary} loading={lapsLoading} error={lapsError} />
      </div>
      <div className="flex min-w-0">
        <SessionStats insights={insights} loading={sessionsLoading} error={sessionsError} periodSummary={periodSummary} />
      </div>
      </div>
    </div>
    </div>
  );
}
