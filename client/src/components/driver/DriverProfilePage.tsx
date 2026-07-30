import type { DriverProfileSummary } from "../../../../server/ai/schemas";
import { parseDriverProfileSummary } from "../../../../server/ai/schemas";
import { useDriverProfile, useDriverProfileRuns, useRunDriverProfile } from "../../hooks/queries";
import { useRequiredGameId } from "../../stores/game";
import { RaceResultSummary } from "../race-results/ResultSummary";
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
  const runError = runMutation.error instanceof Error ? runMutation.error.message : runMutation.error ? String(runMutation.error) : (latestRun?.error ?? null);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-app-title font-semibold text-app-text">Driver Profile</h1>
          <p className="text-app-subtext text-app-text-muted">How your driving is changing</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" className="rounded-md border border-app-border bg-app-surface px-3 py-2 text-app-label text-app-text">
            All {profileQuery.data?.gameName ?? "Forza Motorsport"} laps
          </Button>
          <Button
            type="button"
            className="rounded-md bg-app-accent px-3 py-2 text-app-label font-medium text-app-on-filled hover:bg-app-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={refresh}
            disabled={!canRefresh || runPending}
          >
            {runPending ? "Refreshing…" : "Refresh AI summary"}
          </Button>
        </div>
      </header>
      <RaceResultSummary gameId={gameId} title="Driver result breakdown" />

      {(profileError || runError) && (
        <div className="mb-4 rounded-lg bg-status-danger/10 p-3 text-sm text-status-danger ring-1 ring-status-danger/20" role="alert">
          {profileError ?? runError}
        </div>
      )}

      {profileQuery.isLoading && <div className="rounded-lg bg-app-surface p-8 text-center text-sm text-app-text-muted ring-1 ring-app-border">Loading measured profile…</div>}
      {profileQuery.isError && !fingerprint && <div className="rounded-lg bg-app-surface p-8 text-center text-sm text-app-text-muted ring-1 ring-app-border">Measured profile unavailable.</div>}

      {fingerprint && (
        <DriverProfileView fingerprint={fingerprint} plan={previousPlan} runState={runState} runReason={runsQuery.data?.reason} latestRun={latestRun} runHistory={runs} runPending={runPending} />
      )}
    </div>
  );
}
