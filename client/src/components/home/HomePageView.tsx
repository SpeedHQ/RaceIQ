import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { SessionRecapView } from "@/components/SessionRecap";
import { m } from "@/paraglide/messages";
import { GameBrandCards, GameBrandHeader } from "./Brand";
import { DashboardInsights } from "./DashboardInsights";
import { RecentSessionsTable } from "./RecentSessions";
import { PeriodStatsPanel } from "./Stats";
import type { HomePageViewProps } from "./types";

export function HomePageView({
  gameId,
  gameDisplayName,
  allLaps,
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
  sessionsLoading = false,
  sessionsError = false,
  onAnalyseRecap,
  periodTab,
  periodStats,
  onPeriodTabChange,
}: HomePageViewProps) {
  return (
    <div className="min-h-full bg-app-bg text-app-detail">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 @3xl/workspace:p-6">
        {/* Header */}
        {gameId && <GameBrandHeader gameId={gameId} gameDisplayName={gameDisplayName} />}

        {/* Game cards — only on global homepage */}
        {!gameId && <GameBrandCards gameStats={gameStats} hiddenGames={hiddenGames} />}

        {!gameId && <DashboardInsights laps={allLaps} sessions={sessions} gameId={gameId} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />}

        {gameId ? (
          <div className="space-y-6">
            <main className="min-w-0 space-y-6">
              <section>
                <ActivityHeatmap laps={allLaps.filter((l) => l.gameId === gameId)} />
              </section>

              <section>
                <PeriodStatsPanel periodTab={periodTab} periodStats={periodStats} onPeriodTabChange={onPeriodTabChange} />
              </section>

              <DashboardInsights laps={allLaps} sessions={sessions} gameId={gameId} sessionsLoading={sessionsLoading} sessionsError={sessionsError} />
            </main>

            <aside>
              {latestSession ? (
                <div className="relative overflow-hidden rounded-xl border border-app-border bg-app-bg p-4">
                  <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-app-accent opacity-15 blur-3xl" />
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
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface p-6 text-center text-xs text-app-text-muted">{m.recap_latest_session()}</div>
              )}
            </aside>
            <section>
              <h2 className="mb-2 text-app-subtext font-semibold text-app-text/90">{m.home_recent_sessions()}</h2>
              <RecentSessionsTable sessions={recentSessions} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseSession={onAnalyseSession} loading={sessionsLoading} error={sessionsError} />
            </section>
          </div>
        ) : (
          <div className="space-y-6">
            <main className="min-w-0 space-y-6">
              <ActivityHeatmap laps={allLaps} />

              <div>
                <PeriodStatsPanel periodTab={periodTab} periodStats={periodStats} onPeriodTabChange={onPeriodTabChange} />
              </div>
            </main>

            <aside>
              {latestSession ? (
                <div className="relative overflow-hidden rounded-xl border border-app-border bg-app-bg p-4">
                  <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-app-accent opacity-15 blur-3xl" />
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
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface p-6 text-center text-xs text-app-text-muted">{m.recap_latest_session()}</div>
              )}
            </aside>
            <section>
              <h2 className="mb-2 text-app-subtext font-semibold text-app-text/90">{m.home_recent_sessions()}</h2>
              <RecentSessionsTable sessions={recentSessions} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseSession={onAnalyseSession} loading={sessionsLoading} error={sessionsError} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
