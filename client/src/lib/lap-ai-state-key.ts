import type { FindingGenerationReceipt } from "@shared/racing/findings/types";
import type { LapMeta } from "@shared/racing/sessions/types";

export type LapAiIdentityEvidence = Pick<LapMeta, "id" | "quality" | "qualityGeneration" | "qualityStale" | "analysisGenerationId"> & {
  findingReceipt?: Pick<FindingGenerationReceipt, "generationId" | "contentHash" | "status"> | null;
  findingGenerationId?: string | null;
  findingContentHash?: string | null;
  findingStatus?: FindingGenerationReceipt["status"] | null;
};

export function lapAiStateKey(lap: LapAiIdentityEvidence): string {
  const provenance = lap.quality?.provenance;
  const finding = lap.findingReceipt;
  return [
    lap.id,
    lap.analysisGenerationId ?? "missing",
    lap.qualityGeneration ?? "missing",
    lap.qualityStale ? "stale" : "current",
    provenance?.schemaVersion ?? "missing",
    provenance?.policyVersion ?? "missing",
    provenance?.configurationVersion ?? "missing",
    provenance?.outputGeneration ?? "missing",
    lap.findingGenerationId ?? finding?.generationId ?? "missing",
    lap.findingContentHash ?? finding?.contentHash ?? "missing",
    lap.findingStatus ?? finding?.status ?? "missing",
  ].join(":");
}

export function comparisonAiStateKey(lapA: LapAiIdentityEvidence, lapB: LapAiIdentityEvidence): string {
  return `${lapAiStateKey(lapA)}|${lapAiStateKey(lapB)}`;
}
