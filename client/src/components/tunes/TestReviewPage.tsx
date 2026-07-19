import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { type TuningLapMetric, useLaps, useTuningSession, useTuningSessionLapMetrics } from "../../hooks/queries";
import { BackButton } from "./BackButton";
import { TestReviewDashboard } from "./TestReviewDashboard";
import { TuneSetupChat } from "./TuneSetupChat";

/**
 * TestReviewPage — the post-test review dashboard as its own route
 * (/​<game>/tune/<id>/review?laps=1,2,3) rather than a tab inside the tuning
 * workspace. The lap ids recorded during the test travel in the `laps` search
 * param; laps themselves are re-read from the persisted laps query (they are
 * stamped/persisted server-side as they land, so they survive the navigation).
 */
export function TestReviewPage({ gameId, tuningSessionId, lapIds }: { gameId: "acc" | "ac-evo"; tuningSessionId: number; lapIds: number[] }) {
  const navigate = useNavigate();
  const { data: session } = useTuningSession(tuningSessionId);
  const { data: allLaps = [] } = useLaps();
  const { data: lapMetrics = [] } = useTuningSessionLapMetrics(tuningSessionId);

  const laps = useMemo(() => allLaps.filter((l) => lapIds.includes(l.id)).sort((a, b) => a.lapNumber - b.lapNumber), [allLaps, lapIds]);
  const metricsById = useMemo(() => {
    const m = new Map<number, TuningLapMetric>();
    for (const entry of lapMetrics) m.set(entry.lapId, entry);
    return m;
  }, [lapMetrics]);

  const backToWorkspace = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${gameId}/tune/${tuningSessionId}` } as any);

  return (
    <div className="h-full flex flex-col overflow-hidden p-3 gap-3">
      <BackButton onClick={backToWorkspace} className="shrink-0" />
      {/* Same two-column shape as the workspace: review dashboard left, the
          persistent Setup Engineer chat right — the chat is never hidden. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
        <div className="min-h-0 overflow-y-auto border border-app-border rounded-lg">
          <TestReviewDashboard gameId={gameId} laps={laps} metricsById={metricsById} tuningSessionId={tuningSessionId} />
        </div>
        <div className="min-h-0 flex flex-col border border-app-border rounded-lg overflow-hidden">
          <div className="shrink-0 px-3 py-2 border-b border-app-border">
            <span className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Setup engineer</span>
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <TuneSetupChat sessionId={tuningSessionId} headTestId={session?.headTestId ?? null} />
          </div>
        </div>
      </div>
    </div>
  );
}
