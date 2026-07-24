import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type TuningGameId, useLaps, useTuningSession, useTuningSessionTests } from "../../hooks/queries";
import { TuneReviewDashboard } from "./TuneReviewDashboard";
import { TuneSetupChat } from "./TuneSetupChat";

/**
 * TestReviewPage — the post-test review dashboard as its own route
 * (/​<game>/tuning/<id>/review?testId=5) rather than a tab inside the tuning
 * workspace. When `testId` is present the reviewed laps are derived from it —
 * laps are stamped with their tuning_test_id server-side, so the set is fully
 * recoverable from the id and does NOT need to travel in the URL. `lapIds` is
 * an optional fallback for the transient live-stint review (no test node yet),
 * where the explicit list scopes the view to just the current run.
 */
export function TestReviewPage({ gameId, tuningSessionId, lapIds, testId }: { gameId: TuningGameId; tuningSessionId: number; lapIds?: number[]; testId?: number }) {
  const navigate = useNavigate();
  const { data: session, isLoading: sessionLoading, isError: sessionMissing } = useTuningSession(tuningSessionId);
  const { data: allLaps = [] } = useLaps();
  const tests = useTuningSessionTests(tuningSessionId);
  // Compact summary of whatever lap review is open in the dashboard below,
  // rebuilt by TuneReviewDashboard on every lap switch and piped into the
  // Setup Engineer chat so it "sees what the user sees".
  const [lapReviewContext, setLapReviewContext] = useState<string | null>(null);

  // Prefer deriving the reviewed laps from the test id (URL-clean path). Fall
  // back to the explicit lapIds list only when no testId is given (live stint).
  const laps = useMemo(() => {
    const selected = testId != null ? allLaps.filter((l) => l.tuningTestId === testId) : allLaps.filter((l) => (lapIds ?? []).includes(l.id));
    return [...selected].sort((a, b) => a.lapNumber - b.lapNumber);
  }, [allLaps, lapIds, testId]);

  const activeTest = tests.data?.find((t) => t.id === testId) ?? tests.data?.find((t) => t.id === session?.headTestId) ?? undefined;

  const backToWorkspace = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${getGame(gameId).routePrefix}/tuning/${tuningSessionId}` } as any);

  const backToTuningList = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${getGame(gameId).routePrefix}/tuning` } as any);

  // Session no longer exists (deleted, or its row was lost in a DB reset while
  // its laps survived — see the orphaned-stamp sweep in server/db/index.ts).
  // Show a clean dead-end instead of a dashboard wired to a 404'ing session.
  if (sessionMissing && !sessionLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
        <div className="text-lg font-semibold text-app-text">Tuning session not found</div>
        <div className="text-sm text-app-text-muted max-w-md">
          This tuning session (#{tuningSessionId}) no longer exists — it may have been deleted, or removed when the database was reset. The laps it referenced may still be in your history.
        </div>
        <button type="button" onClick={backToTuningList} className="mt-2 px-4 py-2 text-sm rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold">
          Back to tuning sessions
        </button>
      </div>
    );
  }

  return (
    // Single page scroll: the app shell's outlet wrapper is the only scroll
    // container. This page just flows — the dashboard grows to its content and
    // the chat column is sticky so it stays put while the page scrolls.
    <div className="flex flex-col p-3 gap-3">
      {/* Same two-column shape as the workspace: review dashboard left, the
          persistent Setup Engineer chat right — the chat is never hidden.
          `items-start` lets the sticky chat column pin instead of stretching. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3 items-start">
        <div className="border border-app-border rounded-lg">
          {/* TuneReviewDashboard's gameId union is ACC/AC-Evo (setup-engineer
              panels); F1 rides the ACC path — it never reaches ACC-specific
              setup data, and the sector/tyre analysis is game-agnostic. */}
          <TuneReviewDashboard
            gameId={gameId === "f1-2025" ? "acc" : gameId}
            laps={laps}
            trackName={session?.trackName ?? undefined}
            onBack={backToWorkspace}
            test={activeTest}
            tuningSessionId={tuningSessionId}
            onOpenLapContextChange={setLapReviewContext}
          />
        </div>
        {/* Sticky, viewport-tall chat: pins under the app header (top-0 of the
            scroll container) and scrolls its own message list internally. */}
        <div className="flex flex-col border border-app-border rounded-lg overflow-hidden h-[70vh] lg:sticky lg:top-0 lg:h-[calc(100vh-5.5rem)]">
          <div className="shrink-0 px-3 py-2 border-b border-app-border flex items-center justify-between">
            <span className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Setup engineer</span>
            <button type="button" onClick={backToWorkspace} className="px-3 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold">
              Session
            </button>
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <TuneSetupChat sessionId={tuningSessionId} headTestId={session?.headTestId ?? null} extendedContext={lapReviewContext} />
          </div>
        </div>
      </div>
    </div>
  );
}
