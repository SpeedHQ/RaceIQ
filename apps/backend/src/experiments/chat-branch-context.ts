import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { getLapMetaForExperimentVersion, getLapsForExperiment } from "@raceiq/backend-core/db/experiment-lap-queries";
import { getExperiment } from "@raceiq/backend-core/db/experiment-queries";
import { listExperimentVersions } from "@raceiq/backend-core/db/experiment-version-queries";
import { loadActiveExperimentContext, type ActiveExperimentContext } from "./setup-lineage";

export type ExperimentChatBranchContext = {
  sessionId: number;
  headVersionId: number | null;
  session: NonNullable<Awaited<ReturnType<typeof getExperiment>>>;
  versions: Awaited<ReturnType<typeof listExperimentVersions>>;
  activeVersion: Awaited<ReturnType<typeof listExperimentVersions>>[number] | null;
  laps: LapMeta[];
  lapIds: readonly number[];
  setupContext: ActiveExperimentContext;
};

export type ExperimentChatBranchResolution =
  | { ok: true; branch: ExperimentChatBranchContext }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string; code?: string };

export async function resolveExperimentChatBranch(
  sessionId: number,
  expectedHeadVersionId: number | null,
): Promise<ExperimentChatBranchResolution> {
  const [session, versions] = await Promise.all([getExperiment(sessionId), listExperimentVersions(sessionId)]);
  if (!session) return { ok: false, status: 404, error: "Tuning session not found" };
  if (session.headVersionId !== expectedHeadVersionId) {
    return {
      ok: false,
      status: 409,
      code: "stale_experiment_head",
      error: "Experiment version changed. Refresh the workspace before sending another message.",
    };
  }
  const activeVersion = expectedHeadVersionId == null
    ? null
    : versions.find((version) => version.id === expectedHeadVersionId) ?? null;
  if (expectedHeadVersionId != null && activeVersion == null) {
    return { ok: false, status: 409, code: "stale_experiment_head", error: "Checked-out experiment version no longer exists. Refresh the workspace." };
  }
  const laps = expectedHeadVersionId == null
    ? (await getLapsForExperiment(sessionId)).filter((lap) => lap.experimentVersionId == null)
    : await getLapMetaForExperimentVersion(expectedHeadVersionId);
  const lapIds = laps.map((lap) => lap.id);
  const setupContext = await loadActiveExperimentContext(sessionId, {
    versionId: expectedHeadVersionId,
    lapIds,
  });
  return {
    ok: true,
    branch: {
      sessionId,
      headVersionId: expectedHeadVersionId,
      session,
      versions,
      activeVersion,
      laps,
      lapIds,
      setupContext,
    },
  };
}
