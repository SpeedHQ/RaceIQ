import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { EligibilityDecisionSet } from "../../shared/racing/quality/contracts";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import { canonicalJson } from "../../shared/racing/findings/identity";
import {
  FINDING_SCHEMA_VERSION,
  type CanonicalJson,
  type FindingGenerationReceipt,
  type FindingScope,
} from "../../shared/racing/findings/types";
import type { FindingRecord } from "../../shared/racing/findings/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { LapQualityResult } from "../lap-analysis/quality";
import { deriveFuelPerLap, deriveTyreWear } from "../lap-analysis/metrics";
import { buildDeterministicLapFindings } from "./lap-findings";
import { publishFindingGeneration } from "./publication";
import { createFindingGenerationReceipt, replaceFindingGeneration } from "./store";

export const COMPLETED_LAP_FINDINGS_RULE = {
  id: "deterministic-lap-findings",
  version: "1",
} as const;

export interface CompletedLapFindingInput {
  lapId: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason?: string | null;
  gameId: GameId;
  carOrdinal?: number;
  trackOrdinal?: number;
  sectorTimes?: number[] | null;
  telemetry: TelemetryPacket[];
  quality: LapQualitySummary;
  recordingQuality: LapQualityResult;
  eligibility?: EligibilityDecisionSet | null;
  qualityGeneration?: string | null;
  analysisGenerationId?: string | null;
  qualityStale?: boolean;
  versionIdentity: TelemetryVersionIdentity;
  createdAt?: string;
}

export interface CompletedLapFindingResult {
  scope: FindingScope;
  receipt: FindingGenerationReceipt;
  findingIds: readonly string[];
}

export interface PreparedCompletedLapFindings extends CompletedLapFindingResult {
  findings: readonly FindingRecord[];
}

export interface CompletedLapFindingDependencies {
  build?: typeof buildDeterministicLapFindings;
  analyze?: typeof analyzeLap;
  replace?: typeof replaceFindingGeneration;
  publish?: typeof publishFindingGeneration;
  now?: () => string;
}

function findingSourceId(input: CompletedLapFindingInput): string {
  const provenance = canonicalJson({
    analysisGenerationId: input.analysisGenerationId ?? null,
    qualityGeneration: input.quality.provenance.outputGeneration,
    versionIdentity: input.versionIdentity,
  });
  return `sha256:${createHash("sha256").update(provenance).digest("hex")}`;
}

function generationId(scope: FindingScope, sourceId: string, config: Record<string, CanonicalJson>): string {
  const identity = canonicalJson({
    scope,
    sourceId,
    rule: COMPLETED_LAP_FINDINGS_RULE,
    config,
    schemaVersion: FINDING_SCHEMA_VERSION,
  });
  return `lap-findings:${createHash("sha256").update(identity).digest("hex")}`;
}

/**
 * Builds one completed-lap generation without publishing or activating it.
 * Session finalization batches these prepared inputs in one DB transaction.
 */
export function prepareCompletedLapFindings(
  input: CompletedLapFindingInput,
  dependencies: Pick<CompletedLapFindingDependencies, "build" | "analyze" | "now"> = {},
): PreparedCompletedLapFindings {
  const build = dependencies.build ?? buildDeterministicLapFindings;
  const analyze = dependencies.analyze ?? analyzeLap;
  const createdAt = input.createdAt ?? (dependencies.now ?? (() => new Date().toISOString()))();
  const sourceId = findingSourceId(input);
  const scope: FindingScope = {
    kind: "lap",
    gameId: input.gameId,
    sessionId: String(input.sessionId),
    lapId: String(input.lapId),
  };
  const bundle = build({
    gameId: input.gameId,
    id: input.lapId,
    sessionId: input.sessionId,
    lapNumber: input.lapNumber,
    lapTime: input.lapTime,
    isValid: input.isValid,
    ...(input.invalidReason ? { invalidReason: input.invalidReason } : {}),
    createdAt,
    quality: input.quality,
    eligibility: input.eligibility ?? undefined,
    qualityGeneration: input.qualityGeneration ?? undefined,
    qualityStale: input.qualityStale,
    analysisGenerationId: sourceId,
    ...input.versionIdentity,
    ...(input.carOrdinal == null ? {} : { carOrdinal: input.carOrdinal }),
    ...(input.trackOrdinal == null ? {} : { trackOrdinal: input.trackOrdinal }),
    ...(input.sectorTimes == null ? {} : { sectorTimes: input.sectorTimes }),
    fuelPerLap: deriveFuelPerLap(input.telemetry) ?? null,
    tyreWear: deriveTyreWear(input.telemetry) ?? null,
    telemetry: input.telemetry,
  }, analyze(input.telemetry, input.gameId, input.quality), input.recordingQuality, sourceId);

  const sourceIds = [...new Set(bundle.findings.map((finding) => finding.analysisGenerationId))];
  if (sourceIds.length > 1 || (sourceIds[0] && sourceIds[0] !== sourceId)) {
    throw new Error("Completed lap findings contain inconsistent source identities");
  }
  const constituentRules = [...new Map(bundle.findings.map((finding) => [
    `${finding.rule.id}\u0000${finding.rule.version}`,
    { id: finding.rule.id, version: finding.rule.version },
  ])).values()].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  const config: Record<string, CanonicalJson> = {
    gameId: input.gameId,
    analysisGenerationId: input.analysisGenerationId ?? null,
    qualityGeneration: input.quality.provenance.outputGeneration,
    versionIdentity: { ...input.versionIdentity },
    constituentRules,
  };
  const receipt = createFindingGenerationReceipt({
    generationId: generationId(scope, sourceId, config),
    sourceId,
    rule: COMPLETED_LAP_FINDINGS_RULE,
    config,
    schemaVersion: FINDING_SCHEMA_VERSION,
    createdAt,
  }, bundle.findings);
  const findingIds = bundle.findings.map((finding) => finding.id)
    .sort((left, right) => left.localeCompare(right));
  return { scope, receipt, findings: bundle.findings, findingIds };
}

/**
 * Build, atomically replace, then publish one completed lap generation.
 * Publication occurs only after store activation returns a current receipt.
 */
export async function persistCompletedLapFindings(
  input: CompletedLapFindingInput,
  dependencies: CompletedLapFindingDependencies = {},
): Promise<CompletedLapFindingResult> {
  const prepared = prepareCompletedLapFindings(input, dependencies);
  const replace = dependencies.replace ?? replaceFindingGeneration;
  const publish = dependencies.publish ?? publishFindingGeneration;
  const activeReceipt = await replace(prepared);
  publish(prepared.scope, activeReceipt, prepared.findingIds);
  return { scope: prepared.scope, receipt: activeReceipt, findingIds: prepared.findingIds };
}
