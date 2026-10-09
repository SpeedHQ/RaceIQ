import { EmptyStateOverlay } from "@/components/ui/empty-state-overlay";
import { Skeleton } from "@/components/ui/skeleton";
import { Flag, Gauge, Timer } from "lucide-react";

import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { SessionRecapView } from "@/components/SessionRecap";
import { Card } from "@/components/ui/card";
import { m } from "@/paraglide/messages";
import { GameBrandCards } from "./Brand";
import { DashboardInsights } from "./DashboardInsights";
import { RecentSessionsTable } from "./RecentSessions";
import { PeriodSelector } from "./Stats";
import type { HomePageViewProps } from "./types";
import { Link } from "@tanstack/react-router";
import { getGameRoute } from "@/stores/game";

export function HomePageView({
  gameId,
  response,
  periodStart,
  sessions,
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
  latestRecapCarImageUrl,
  onAnalyseSession,
  lapsLoading = false,
  lapsError = false,
  sessionsLoading = false,
  sessionsError = false,
  periodTab,
  periodStats,
  onPeriodTabChange,
}: HomePageViewProps) {
  const recapDestination = latestSession && latestRecap && !latestRecapLoading && !latestRecapError
    ? `${getGameRoute(latestRecap.gameId)}/sessions/${latestRecap.sessionId}/analyse` as never
    : null;
  const latestSessionLoading = latestRecapLoading || sessionsLoading;
  const showFinishPlaceholder = !latestSession || /^(race|sprint)/i.test(latestSession.sessionType?.trim() ?? "");
  const latestSessionCard = (
    <Card variant="transparent-panel" className="dashboard-hover-panel latest-session-card relative h-full p-4" aria-busy={latestSessionLoading}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="mb-2 text-app-heading font-semibold text-app-text">{m.recap_latest_session()}</h2>
        {latestRecap?.personalBest?.isNew && latestRecap.bestLapSec != null && <span className="recap-pb shrink-0 px-2 py-0.5 text-app-label font-semibold">{m.recap_new_pb()}</span>}
      </div>
      {latestRecap && latestSession && !latestRecapLoading && !latestRecapError ? (
        <SessionRecapView
          recap={latestRecap}
          gameId={latestRecap.gameId}
          compact
          sessionType={latestSession.sessionType ?? undefined}
          showTrackMap={false}
          finishPosition={undefined}
          resultClassification={undefined}
          outlineData={latestRecapOutline}
          bounds={latestRecapBounds}
          carImageUrl={latestRecapCarImageUrl}
        />
      ) : (
        <div className="recap-cinematic @container relative isolate flex min-w-0 flex-col gap-3" aria-busy={latestSessionLoading}>
          <div className="relative flex min-h-20 min-w-0 flex-col justify-center gap-3 @sm:flex-row @sm:items-center @sm:justify-between">
            <div className="relative min-w-0 max-w-[65%] @max-sm:max-w-full">
              <div className="flex items-center gap-3">
                <div aria-hidden="true" className="h-12 w-16 shrink-0" />
                <div className="min-w-0 break-words text-app-heading font-semibold leading-tight text-app-text"><Skeleton loading={latestSessionLoading}>{latestSession?.track.name ?? "—"}</Skeleton></div>
              </div>
              <div className="mt-2 flex items-start gap-2 text-app-subtext text-app-text-secondary">
                <span className="shrink-0 rounded border border-app-accent/30 bg-app-accent/10 px-2 py-0.5 text-app-label font-semibold uppercase text-app-accent"><Skeleton loading={latestSessionLoading}>{latestSession?.gameId ?? "—"}</Skeleton></span>
                <span className="break-words"><Skeleton loading={latestSessionLoading}>{latestSession?.car.name ?? "—"}</Skeleton></span>
              </div>
              <div className="mt-2 text-app-label text-app-text-muted"><Skeleton loading={latestSessionLoading}>—</Skeleton> · <Skeleton loading={latestSessionLoading}>{latestSession?.sessionType ?? "—"}</Skeleton></div>
          </div>
          </div>
              <div className="relative flex min-w-0 flex-col gap-3">
                <div className="grid min-w-0 gap-2 @md:grid-cols-[1.65fr_3fr]">
                  <div className="recap-best-lap min-w-0 p-2.5"><div className="recap-label">{m.recap_best_lap()}</div><div className="recap-best-time mt-2 whitespace-nowrap font-mono font-semibold tabular-nums leading-none"><Skeleton loading={latestSessionLoading}>—</Skeleton></div></div>
                  <div className="grid min-w-0 grid-cols-3 gap-2">
                    {[1, 2, 3].map((sector) => <div key={sector} className="recap-sector min-w-0 p-2"><div className="recap-label">S{sector}</div><div className="mt-2 font-mono text-app-subtext font-semibold tabular-nums @2xl:text-app-heading text-app-text"><Skeleton loading={latestSessionLoading}>—</Skeleton></div></div>)}
                  </div>
                </div>
                <div className="recap-footer flex min-w-0 flex-col gap-3 p-2.5 @lg:flex-row @lg:items-center">
                  <div className={`grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-3 ${showFinishPlaceholder ? "@md:grid-cols-4" : "@md:grid-cols-3"}`}>
                    <div className="flex min-w-0 items-center gap-2"><Flag aria-hidden="true" className="size-5 shrink-0 text-app-text-muted" /><div><div className="text-app-label text-app-text-muted">{m.recap_laps()}</div><div className="font-mono text-app-subtext font-semibold tabular-nums text-app-text"><Skeleton loading={latestSessionLoading}>—</Skeleton></div></div></div>
                    <div className="flex min-w-0 items-center gap-2"><Gauge aria-hidden="true" className="size-5 shrink-0 text-app-text-muted" /><div><div className="text-app-label text-app-text-muted">{m.recap_distance()}</div><div className="font-mono text-app-subtext font-semibold tabular-nums text-app-text"><Skeleton loading={latestSessionLoading}>—</Skeleton></div></div></div>
                    <div className="flex min-w-0 items-center gap-2"><Timer aria-hidden="true" className="size-5 shrink-0 text-app-text-muted" /><div><div className="text-app-label text-app-text-muted">{m.recap_time_on_track()}</div><div className="font-mono text-app-subtext font-semibold tabular-nums text-app-text"><Skeleton loading={latestSessionLoading}>—</Skeleton></div></div></div>
                    {showFinishPlaceholder && <div className="min-w-0"><div className="text-app-label text-app-text-muted">{m.common_finish()}</div><div className="font-mono text-app-heading font-semibold tabular-nums text-app-text"><Skeleton loading={latestSessionLoading}>—</Skeleton></div></div>}
                  </div>
                </div>
              </div>
              <p className="sr-only" role={latestRecapError || sessionsError ? "alert" : "status"}>
                {latestRecapError || sessionsError ? m.common_error() : latestSessionLoading ? m.common_loading() : latestSession ? m.common_loading() : m.home_no_sessions()}
              </p>
            </div>
      )}
      {!latestSession && !latestRecap && !latestRecapLoading && !sessionsLoading && !latestRecapError && !sessionsError && <EmptyStateOverlay />}
    </Card>
  );
  const latestSessionPanel = (
    <aside className="min-w-0">
      {recapDestination ? <Link className="latest-session-link block h-full" to={recapDestination} aria-label={`${m.sessions_analyse_session()}: ${latestRecap?.trackName ?? ""}`}>{latestSessionCard}</Link> : latestSessionCard}
    </aside>
  );
  return (
    <div className="min-h-full bg-app-bg text-app-detail">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4 @3xl/workspace:p-6">
        <PeriodSelector periodTab={periodTab} onPeriodTabChange={onPeriodTabChange} />
        <GameBrandCards gameStats={gameStats} hiddenGames={hiddenGames} loading={lapsLoading || sessionsLoading} error={lapsError || sessionsError} selectedGameId={gameId} />


        <div className="space-y-4">
          <main className="min-w-0">
            <DashboardInsights response={response} gameId={gameId} periodStart={periodStart} trackNames={trackNames} carNames={carNames} latestSession={latestSessionPanel} periodSummary={periodStats[periodTab]} lapsLoading={lapsLoading || sessionsLoading} lapsError={lapsError || sessionsError} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />
          </main>

          <div className="grid min-w-0 items-start gap-3 @3xl/workspace:grid-cols-3">
            <section className="min-w-0 @3xl/workspace:col-span-2">
              <RecentSessionsTable sessions={sessions} gameId={gameId} onAnalyseSession={onAnalyseSession} loading={sessionsLoading} error={sessionsError} />
            </section>
            <ActivityHeatmap buckets={response?.calendar ?? []} periodStart={periodStart} loading={lapsLoading || sessionsLoading} error={lapsError || sessionsError} />
          </div>
        </div>
      </div>
    </div>
  );
}
