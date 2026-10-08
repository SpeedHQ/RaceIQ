import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { SessionRecapView } from "@/components/SessionRecap";
import { Card } from "@/components/ui/card";
import { m } from "@/paraglide/messages";
import { GameBrandCards, GameBrandHeader } from "./Brand";
import { DashboardInsights } from "./DashboardInsights";
import { RecentSessionsTable } from "./RecentSessions";
import { PeriodSelector } from "./Stats";
import type { HomePageViewProps } from "./types";
import { Link } from "@tanstack/react-router";
import { getGameRoute } from "@/stores/game";

export function HomePageView({
  gameId,
  gameDisplayName,
  allLaps,
  periodStart,
  sessions,
  recentSessions,
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
  const latestSessionPanel = (
    <aside className="min-w-0">
      {latestSession ? (
        <Link className="latest-session-link block h-full" to={latestRecap ? `${getGameRoute(latestRecap.gameId)}/sessions/${latestRecap.sessionId}/analyse` as never : "/"} disabled={!latestRecap} aria-label={`${m.sessions_analyse_session()}: ${latestRecap?.trackName ?? ""}`}>
          <Card variant="transparent-panel" className="latest-session-card relative h-full overflow-hidden p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="recap-card-title">{m.recap_latest_session()}</div>
                    {latestRecap?.personalBest?.isNew && latestRecap.bestLapSec != null && <span className="recap-pb shrink-0 px-2 py-0.5 text-app-label font-semibold">{m.recap_new_pb()}</span>}
                  </div>
                  {latestRecapLoading ? (
                    <div className="p-6 text-center text-app-text-dim">{m.common_loading()}</div>
                  ) : latestRecapError || !latestRecap ? (
                    <div className="p-6 text-center text-status-danger">{m.common_error()}</div>
                  ) : (
                    <SessionRecapView
                      recap={latestRecap}
                      gameId={latestRecap.gameId}
                      compact
                      sessionType={latestSession.sessionType}
                      showTrackMap={false}
                      finishPosition={latestSession.finishingPosition}
                      resultClassification={latestSession.resultClassification}
                      outlineData={latestRecapOutline}
                      bounds={latestRecapBounds}
                      carImageUrl={latestRecapCarImageUrl}
                    />
                  )}
          </Card>
        </Link>
      ) : (
        <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-app-border p-6 text-center text-xs text-app-text-muted">{m.recap_latest_session()}</div>
      )}
    </aside>
  );
  return (
    <div className="min-h-full bg-app-bg text-app-detail">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4 @3xl/workspace:p-6">
        <PeriodSelector periodTab={periodTab} onPeriodTabChange={onPeriodTabChange} />
        {/* Header */}
        {gameId && <GameBrandHeader gameId={gameId} gameDisplayName={gameDisplayName} />}

        {/* Game cards — only on global homepage */}
        {!gameId && <GameBrandCards gameStats={gameStats} hiddenGames={hiddenGames} />}

        {gameId ? (
          <div className="space-y-6">
            <main className="min-w-0 space-y-6">
              <section>
                <ActivityHeatmap laps={allLaps.filter((l) => l.gameId === gameId)} periodStart={periodStart} />
              </section>

              <DashboardInsights latestSession={latestSessionPanel} laps={allLaps} sessions={sessions} gameId={gameId} trackNames={trackNames} carNames={carNames} periodSummary={periodStats[periodTab]} lapsLoading={lapsLoading || sessionsLoading} lapsError={lapsError || sessionsError} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />
            </main>

            <section>
              <h2 className="mb-2 text-app-subtext font-semibold text-app-text/90">{m.home_recent_sessions()}</h2>
              <RecentSessionsTable
                sessions={recentSessions}
                carNames={carNames}
                trackNames={trackNames}
                gameId={gameId}
                onAnalyseSession={onAnalyseSession}
                loading={sessionsLoading}
                error={sessionsError}
              />
            </section>
          </div>
        ) : (
          <div className="space-y-4">
            <main className="min-w-0">
              <DashboardInsights latestSession={latestSessionPanel} laps={allLaps} sessions={sessions} gameId={gameId} trackNames={trackNames} carNames={carNames} periodSummary={periodStats[periodTab]} lapsLoading={lapsLoading || sessionsLoading} lapsError={lapsError || sessionsError} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />
            </main>

            <div className="grid min-w-0 items-start gap-3 @3xl/workspace:grid-cols-3">
              <section className="min-w-0 @3xl/workspace:col-span-2">
                <h2 className="mb-2 text-app-subtext font-semibold text-app-text/90">{m.home_recent_sessions()}</h2>
                <RecentSessionsTable
                  sessions={recentSessions}
                  carNames={carNames}
                  trackNames={trackNames}
                  gameId={gameId}
                  onAnalyseSession={onAnalyseSession}
                  loading={sessionsLoading}
                  error={sessionsError}
                />
              </section>
              <ActivityHeatmap laps={allLaps} periodStart={periodStart} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
