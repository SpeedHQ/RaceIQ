import type { LapMeta } from "@shared/racing/sessions/types";

export type LapAiIdentityEvidence = Pick<LapMeta, "id" | "quality" | "qualityGeneration" | "qualityStale">;

export function lapAiStateKey(lap: LapAiIdentityEvidence): string {
  const provenance = lap.quality?.provenance;
  return [
    lap.id,
    lap.qualityGeneration ?? "missing",
    lap.qualityStale ? "stale" : "current",
    provenance?.schemaVersion ?? "missing",
    provenance?.policyVersion ?? "missing",
    provenance?.configurationVersion ?? "missing",
    provenance?.outputGeneration ?? "missing",
  ].join(":");
}

export function comparisonAiStateKey(lapA: LapAiIdentityEvidence, lapB: LapAiIdentityEvidence): string {
  return [lapAiStateKey(lapA), lapAiStateKey(lapB)].sort().join("|");
}
