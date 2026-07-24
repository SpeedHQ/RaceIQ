import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type TuningGameId, useLaps, useTuningSession, useTuningSessionTests } from "../../hooks/queries";
import { BackButton } from "./BackButton";
import { TuneReviewDashboard } from "./TuneReviewDashboard";
import { TuneSetupChat } from "./TuneSetupChat";

/**
 * TestReviewPage — the post-test review dashboard as its own route
 * (/​<game>/tuning/<id>/review?laps=1,2,3) rather than a tab inside the tuning
 * workspace. The lap ids recorded during the test travel in the `laps` search
 * param; laps themselves are re-read from the persisted laps query (they are
 * stamped/persisted server-side as they land, so they survive the navigation).
 */
export function TestReviewPage({ gameId, tuningSessionId, lapIds, testId }: { gameId: TuningGameId; tuningSessionId: number; lapIds: number[]; testId?: number }) {
  const navigate = useNavigate();
  const { data: session } = useTuningSession(tuningSessionId);
  const { data: allLaps = [] } = useLaps();
  const tests = useTuningSessionTests(tuningSessionId);
  // Compact summary of whatever lap review is open in the dashboard below,
  // rebuilt by TuneReviewDashboard on every lap switch and piped into the
  // Setup Engineer chat so it "sees what the user sees".
  const [lapReviewContext, setLapReviewContext] = useState<string | null>(null);

  const laps = useMemo(() => allLaps.filter((l) => lapIds.includes(l.id)).sort((a, b) => a.lapNumber - b.lapNumber), [allLaps, lapIds]);

  const activeTest = tests.data?.find((t) => t.id === testId) ?? tests.data?.find((t) => t.id === session?.headTestId) ?? undefined;

  const backToWorkspace = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${getGame(gameId).routePrefix}/tuning/${tuningSessionId}` } as any);

  return (
    <div className="h-full flex flex-col overflow-hidden p-3 gap-3">
      <BackButton onClick={backToWorkspace} className="shrink-0" />
      {/* Same two-column shape as the workspace: review dashboard left, the
          persistent Setup Engineer chat right — the chat is never hidden. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
        <div className="min-h-0 overflow-y-auto border border-app-border rounded-lg">
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
        <div className="min-h-0 flex flex-col border border-app-border rounded-lg overflow-hidden">
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
