import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { SessionRecapView } from "@/components/SessionRecap";
import { Card } from "@/components/ui/card";
import { m } from "@/paraglide/messages";
import { GameBrandCards, GameBrandHeader } from "./Brand";
import { DashboardInsights } from "./DashboardInsights";
import { RecentSessionsTable } from "./RecentSessions";
import { PeriodSelector, PeriodStatsPanel } from "./Stats";
import type { HomePageViewProps } from "./types";

export function HomePageView({
  gameId,
  gameDisplayName,
  allLaps,
  calendarLaps,
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
  recapCopied,
  onCopyRecap,
  onAnalyseSession,
  lapsLoading = false,
  lapsError = false,
  sessionsLoading = false,
  sessionsError = false,
  onAnalyseRecap,
  periodTab,
  periodStats,
  onPeriodTabChange,
}: HomePageViewProps) {
  return (
    <div className="min-h-full bg-app-bg text-app-detail">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4 @3xl/workspace:p-6">
        <PeriodSelector periodTab={periodTab} onPeriodTabChange={onPeriodTabChange} />
        {/* Header */}
        {gameId && <GameBrandHeader gameId={gameId} gameDisplayName={gameDisplayName} />}

        {/* Game cards — only on global homepage */}
        {!gameId && <GameBrandCards gameStats={gameStats} hiddenGames={hiddenGames} />}
        {!gameId && (
            <aside>
              {latestSession ? (
                <Card variant="gradient" className="p-4">
                  <div className="relative mb-3 flex items-center gap-2 text-app-label font-semibold uppercase tracking-app-label text-app-accent">
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
                      compact
                      showTrackMap={false}
                      finishPosition={latestSession.finishingPosition}
                      copied={recapCopied}
                      onCopy={onCopyRecap}
                      onAnalyse={onAnalyseRecap}
                      outlineData={latestRecapOutline}
                      bounds={latestRecapBounds}
                    />
                  )}
                </Card>
              ) : (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface p-6 text-center text-xs text-app-text-muted">{m.recap_latest_session()}</div>
              )}
            </aside>
        )}

        {gameId ? (
          <div className="space-y-6">
            <main className="min-w-0 space-y-6">
              <section>
                <ActivityHeatmap laps={calendarLaps.filter((l) => l.gameId === gameId)} />
              </section>

              <section>
                <PeriodStatsPanel periodTab={periodTab} periodStats={periodStats} />
              </section>

              <DashboardInsights laps={allLaps} sessions={sessions} gameId={gameId} trackNames={trackNames} carNames={carNames} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />
            </main>

            <aside>
              {latestSession ? (
                <Card variant="gradient" className="p-4">
                  <div className="relative mb-3 flex items-center gap-2 text-app-label font-semibold uppercase tracking-app-label text-app-accent">
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
                      compact
                      showTrackMap={false}
                      finishPosition={latestSession.finishingPosition}
                      copied={recapCopied}
                      onCopy={onCopyRecap}
                      onAnalyse={onAnalyseRecap}
                      outlineData={latestRecapOutline}
                      bounds={latestRecapBounds}
                    />
                  )}
                </Card>
              ) : (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface p-6 text-center text-xs text-app-text-muted">{m.recap_latest_session()}</div>
              )}
            </aside>
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
            <DashboardInsights laps={allLaps} sessions={sessions} gameId={gameId} trackNames={trackNames} carNames={carNames} lapsLoading={lapsLoading || sessionsLoading} lapsError={lapsError || sessionsError} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />

            <main className="grid min-w-0 items-center gap-3 @min-[960px]/workspace:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
              <ActivityHeatmap laps={calendarLaps} />
              <PeriodStatsPanel periodTab={periodTab} periodStats={periodStats} />
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
        )}
      </div>
    </div>
  );
}
