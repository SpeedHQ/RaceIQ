import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import { canonicalJson } from "../../shared/racing/findings/identity";
import {
  FINDING_SCHEMA_VERSION,
  type CanonicalJson,
  type FindingGenerationReceipt,
  type FindingScope,
} from "../../shared/racing/findings/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapQualityResult } from "../lap-analysis/quality";
import { deriveFuelPerLap, deriveTyreWear } from "../lap-analysis/metrics";
import {
  buildDeterministicLapFindings,
  DETERMINISTIC_LAP_FINDINGS_SOURCE_ID,
} from "./lap-findings";
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
  quality: LapQualityResult;
  createdAt?: string;
}

export interface CompletedLapFindingResult {
  scope: FindingScope;
  receipt: FindingGenerationReceipt;
  findingIds: readonly string[];
}

export interface CompletedLapFindingDependencies {
  build?: typeof buildDeterministicLapFindings;
  analyze?: typeof analyzeLap;
  replace?: typeof replaceFindingGeneration;
  publish?: typeof publishFindingGeneration;
  now?: () => string;
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
 * Build, atomically replace, then publish one completed lap generation.
 * Publication occurs only after store activation returns a current receipt.
 */
export async function persistCompletedLapFindings(
  input: CompletedLapFindingInput,
  dependencies: CompletedLapFindingDependencies = {},
): Promise<CompletedLapFindingResult> {
  const build = dependencies.build ?? buildDeterministicLapFindings;
  const analyze = dependencies.analyze ?? analyzeLap;
  const replace = dependencies.replace ?? replaceFindingGeneration;
  const publish = dependencies.publish ?? publishFindingGeneration;
  const createdAt = input.createdAt ?? (dependencies.now ?? (() => new Date().toISOString()))();
  const scope: FindingScope = {
    kind: "lap",
    sessionId: String(input.sessionId),
    lapId: String(input.lapId),
  };
  const bundle = build({
    id: input.lapId,
    sessionId: input.sessionId,
    lapNumber: input.lapNumber,
    lapTime: input.lapTime,
    isValid: input.isValid,
    ...(input.invalidReason ? { invalidReason: input.invalidReason } : {}),
    createdAt,
    gameId: input.gameId,
    ...(input.carOrdinal == null ? {} : { carOrdinal: input.carOrdinal }),
    ...(input.trackOrdinal == null ? {} : { trackOrdinal: input.trackOrdinal }),
    ...(input.sectorTimes == null ? {} : { sectorTimes: input.sectorTimes }),
    fuelPerLap: deriveFuelPerLap(input.telemetry) ?? null,
    tyreWear: deriveTyreWear(input.telemetry) ?? null,
    telemetry: input.telemetry,
  }, analyze(input.telemetry, input.gameId), input.quality);

  const sourceIds = [...new Set(bundle.findings.map((finding) => finding.analysisGenerationId))];
  if (sourceIds.length > 1 || (sourceIds[0] && sourceIds[0] !== DETERMINISTIC_LAP_FINDINGS_SOURCE_ID)) {
    throw new Error("Completed lap findings contain inconsistent source identities");
  }
  const constituentRules = [...new Map(bundle.findings.map((finding) => [
    `${finding.rule.id}\u0000${finding.rule.version}`,
    { id: finding.rule.id, version: finding.rule.version },
  ])).values()].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  const config: Record<string, CanonicalJson> = { constituentRules };
  const receipt = createFindingGenerationReceipt({
    generationId: generationId(scope, DETERMINISTIC_LAP_FINDINGS_SOURCE_ID, config),
    sourceId: DETERMINISTIC_LAP_FINDINGS_SOURCE_ID,
    rule: COMPLETED_LAP_FINDINGS_RULE,
    config,
    schemaVersion: FINDING_SCHEMA_VERSION,
    createdAt,
  }, bundle.findings);
  const activeReceipt = await replace({ scope, receipt, findings: bundle.findings });
  const findingIds = bundle.findings.map((finding) => finding.id)
    .sort((left, right) => left.localeCompare(right));
  publish(scope, activeReceipt, findingIds);
  return { scope, receipt: activeReceipt, findingIds };
}
