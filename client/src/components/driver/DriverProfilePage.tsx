import type { DriverProfileSummary } from "../../../../server/ai/schemas";
import { parseDriverProfileSummary } from "../../../../server/ai/schemas";
import { useDriverProfile, useDriverProfileRuns, useRunDriverProfile } from "../../hooks/queries";
import { useRequiredGameId } from "../../stores/game";
import { DriverProfileView } from "./DriverProfileView";

/**
 * Driver profile data is deliberately global within selected game. The server
 * owns lap selection and returns deterministic trend data before any AI run.
 */
export function DriverProfilePage() {
  const gameId = useRequiredGameId();
  const profileQuery = useDriverProfile({ gameId });
  const runsQuery = useDriverProfileRuns({ gameId });
  const runMutation = useRunDriverProfile();

  const fingerprint = profileQuery.data?.fingerprint ?? null;
  const runs = runsQuery.data?.runs ?? [];
  const latestRun = runsQuery.data?.latest ?? null;
  let previousPlan: DriverProfileSummary | null = null;
  for (const run of runs) {
    if (run.status !== "succeeded" || !run.plan) continue;
    const parsed = parseDriverProfileSummary(run.plan);
    if (parsed.success) {
      previousPlan = parsed.data;
      break;
    }
  }

  const runActive = latestRun?.status === "queued" || latestRun?.status === "running";
  const runPending = runMutation.isPending || runActive;
  const runState = runsQuery.data?.state;
  const canRefresh = Boolean(fingerprint?.ok && runsQuery.data?.configured && !runPending);
  const refresh = () => {
    if (!canRefresh) return;
    runMutation.mutate({ gameId, retry: runState === "failed" });
  };
  const profileError = profileQuery.error instanceof Error ? profileQuery.error.message : profileQuery.error ? String(profileQuery.error) : null;
  const runError = runMutation.error instanceof Error ? runMutation.error.message : runMutation.error ? String(runMutation.error) : latestRun?.error ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-app-text">Driver Profile</h1>
          <p className="text-sm text-app-text-muted">Your global trend for {profileQuery.data?.gameName ?? "this game"}.</p>
        </div>
      </header>

      {(profileError || runError) && (
        <div className="mb-4 rounded-lg bg-dynamics-red/10 p-3 text-sm text-dynamics-red ring-1 ring-dynamics-red/20" role="alert">
          {profileError ?? runError}
        </div>
      )}

      {profileQuery.isLoading && <div className="rounded-lg bg-app-surface p-8 text-center text-sm text-app-text-muted ring-1 ring-app-border">Loading measured profile…</div>}
      {profileQuery.isError && !fingerprint && <div className="rounded-lg bg-app-surface p-8 text-center text-sm text-app-text-muted ring-1 ring-app-border">Measured profile unavailable.</div>}

      {fingerprint && (
        <DriverProfileView
          fingerprint={fingerprint}
          plan={previousPlan}
          runState={runState}
          runReason={runsQuery.data?.reason}
          latestRun={latestRun}
          runHistory={runs}
          onRefresh={canRefresh ? refresh : undefined}
          runPending={runPending}
        />
      )}
    </div>
  );
}
