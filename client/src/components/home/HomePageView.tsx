import { Settings2 } from "lucide-react";
import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { SessionRecapView } from "@/components/SessionRecap";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { GameBrandCards, GameBrandHeader } from "./Brand";
import { RecentLapsTable } from "./RecentLaps";
import { PeriodStatsPanel } from "./Stats";
import type { HomePageViewProps } from "./types";

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
  lapsLoading = false,
  lapsError = false,
  onAnalyseRecap,
  periodTab,
  periodStats,
  onPeriodTabChange,
  onOpenSettings,
}: HomePageViewProps) {
  return (
    <div className="min-h-full bg-app-bg">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 @3xl/workspace:p-6">
        {/* Header */}
        {gameId ? (
          <GameBrandHeader gameId={gameId} gameDisplayName={gameDisplayName} />
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
        {!gameId && <GameBrandCards gameStats={gameStats} hiddenGames={hiddenGames} />}

        {gameId ? (
          <div className="grid grid-cols-1 items-start gap-6 @5xl/workspace:grid-cols-[minmax(0,1fr)_380px]">
            <main className="min-w-0 space-y-6">
              <section>
                <ActivityHeatmap laps={allLaps.filter((l) => l.gameId === gameId)} />
              </section>

              <section>
                <PeriodStatsPanel periodTab={periodTab} periodStats={periodStats} onPeriodTabChange={onPeriodTabChange} />
              </section>

              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text/90">{m.home_recent_laps()}</h2>
                <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseLap={onAnalyseLap} loading={lapsLoading} error={lapsError} />
              </section>
            </main>

            <aside className="@5xl/workspace:sticky @5xl/workspace:top-6">
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
              <PeriodStatsPanel periodTab={periodTab} periodStats={periodStats} onPeriodTabChange={onPeriodTabChange} />
            </div>

            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-app-text/90">{m.home_recent_laps()}</h2>
              <RecentLapsTable laps={recentLaps} carNames={carNames} trackNames={trackNames} gameId={gameId} onAnalyseLap={onAnalyseLap} loading={lapsLoading} error={lapsError} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
