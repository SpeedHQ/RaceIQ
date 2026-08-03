import { getGame } from "@shared/games/registry";
import { DEFAULT_EXPERIMENT_FOCUS, EXPERIMENT_FOCUS_AGENT_LABELS } from "@shared/racing/experiments/focus";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type ExperimentGameId, useExperiment, useExperimentVersions, useLaps } from "../../hooks/queries";
import { Button } from "../ui/button";
import { TuneReviewDashboard } from "./TuneReviewDashboard";
import { TuneSetupChat } from "./TuneSetupChat";

/**
 * TestReviewPage — the post-test review dashboard as its own route
 * (/​<game>/experiments/<id>/review?versionId=5) rather than a tab inside the tuning
 * workspace. When `versionId` is present the reviewed laps are derived from it —
 * laps are stamped with their experiment_version_id server-side, so the set is fully
 * recoverable from the id and does NOT need to travel in the URL. `lapIds` is
 * an optional fallback for the transient live-stint review (no test node yet),
 * where the explicit list scopes the view to just the current run.
 */
export function TestReviewPage({ gameId, experimentId, lapIds, versionId }: { gameId: ExperimentGameId; experimentId: number; lapIds?: number[]; versionId?: number }) {
  const navigate = useNavigate();
  const { data: session, isLoading: sessionLoading, isError: sessionMissing } = useExperiment(experimentId);
  const { data: allLaps = [] } = useLaps();
  const tests = useExperimentVersions(experimentId);
  // Compact summary of whatever lap review is open in the dashboard below,
  // rebuilt by TuneReviewDashboard on every lap switch and piped into the
  // Setup Engineer chat so it "sees what the user sees".
  const [lapReviewContext, setLapReviewContext] = useState<string | null>(null);

  // Prefer deriving the reviewed laps from the test id (URL-clean path). Fall
  // back to the explicit lapIds list only when no versionId is given (live stint).
  const laps = useMemo(() => {
    const selected = versionId != null ? allLaps.filter((l) => l.experimentVersionId === versionId) : allLaps.filter((l) => (lapIds ?? []).includes(l.id));
    return [...selected].sort((a, b) => a.lapNumber - b.lapNumber);
  }, [allLaps, lapIds, versionId]);

  const activeTest = tests.data?.find((t) => t.id === versionId) ?? tests.data?.find((t) => t.id === session?.headVersionId) ?? undefined;

  const backToWorkspace = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${getGame(gameId).routePrefix}/experiments/${experimentId}` } as any);

  const backToExperimentList = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${getGame(gameId).routePrefix}/experiments` } as any);

  // Session no longer exists (deleted, or its row was lost in a DB reset while
  // its laps survived — see the orphaned-stamp sweep in server/db/index.ts).
  // Show a clean dead-end instead of a dashboard wired to a 404'ing session.
  if (sessionLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
        <div className="text-lg font-semibold text-app-text">Loading experiment review…</div>
      </div>
    );
  }
  if (sessionMissing || !session) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
        <div role="alert" className="text-lg font-semibold text-app-text">
          Experiment not found
        </div>
        <div className="text-sm text-app-text-muted max-w-md">
          This experiment (#{experimentId}) no longer exists — it may have been deleted, or removed when the database was reset. The laps it referenced may still be in your history.
        </div>
        <Button variant="app-primary" size="app-md" onClick={backToExperimentList} className="mt-2">
          Back to experiments
        </Button>
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
      <div className="grid grid-cols-1 items-start gap-3 @5xl/workspace:grid-cols-[1fr_360px]">
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
            experimentId={experimentId}
            onOpenLapContextChange={setLapReviewContext}
          />
        </div>
        {/* Sticky, viewport-tall chat: pins under the app header (top-0 of the
            scroll container) and scrolls its own message list internally. */}
        <div className="flex h-[70vh] flex-col overflow-hidden rounded-lg border border-app-border @5xl/workspace:sticky @5xl/workspace:top-0 @5xl/workspace:h-[calc(100vh-5.5rem)]">
          <div className="shrink-0 px-3 py-2 border-b border-app-border flex items-center justify-between">
            {/* Named after the experiment's current focus, same as the
                workspace panel — one agent, two modes. */}
            <span className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{EXPERIMENT_FOCUS_AGENT_LABELS[session?.focus ?? DEFAULT_EXPERIMENT_FOCUS]}</span>
            <Button variant="app-primary" size="app-sm" onClick={backToWorkspace}>
              Session
            </Button>
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <TuneSetupChat sessionId={experimentId} headVersionId={session?.headVersionId ?? null} extendedContext={lapReviewContext} />
          </div>
        </div>
      </div>
    </div>
  );
}
