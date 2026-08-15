import type { TelemetryVariableId } from "@shared/telemetry/catalog/generated/telemetry-catalog.types";
import type {
  ChannelIssueInterval,
  ChannelQualitySummary,
  EligibilityDecision,
  EligibilityDecisionSet,
  EligibilityEvaluationOptions,
  EligibilityPolicyId,
  EligibilityReason,
  EligibilityStatus,
  GroupEligibilityContext,
  GroupEligibilityLap,
  LapQualitySummary,
  QualityDistanceRange,
  QualityFact,
  QualityReasonCode,
} from "./contracts";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION } from "./contracts";
import { QUALITY_THRESHOLDS_V1 } from "./measure";
import { QUALITY_REASON_META } from "./reasons";

const POLICY_IDS = [
  "official-timing",
  "normal-pace",
  "lap-comparison",
  "corner-trace",
  "transient-event",
  "fuel-burn",
  "tire-analysis",
  "stint-falloff",
  "setup-analysis",
  "driver-profile",
  "ml-training",
] as const satisfies readonly EligibilityPolicyId[];

export interface QualitySnapshotEvidence {
  quality?: LapQualitySummary | null;
  eligibility?: Partial<EligibilityDecisionSet> | null;
  qualityGeneration?: string | null;
  qualityStale?: boolean;
  qualitySchemaVersion?: string | null;
  qualityPolicyVersion?: string | null;
  qualityConfigVersion?: string | null;
}

function isFinalizedQualityGeneration(generation: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(generation);
}

export function isQualitySnapshotCurrent(evidence: QualitySnapshotEvidence): boolean {
  const provenance = evidence.quality?.provenance;
  if (!provenance || evidence.qualityStale === true) return false;
  if (!isFinalizedQualityGeneration(provenance.sourceGeneration) || !isFinalizedQualityGeneration(provenance.outputGeneration)) return false;
  if (provenance.schemaVersion !== QUALITY_SCHEMA_VERSION || provenance.policyVersion !== ELIGIBILITY_POLICY_VERSION || provenance.configurationVersion !== QUALITY_CONFIG_VERSION) {
    return false;
  }
  if (evidence.qualityGeneration !== undefined && evidence.qualityGeneration !== provenance.outputGeneration) return false;
  if (evidence.qualitySchemaVersion !== undefined && evidence.qualitySchemaVersion !== QUALITY_SCHEMA_VERSION) return false;
  if (evidence.qualityPolicyVersion !== undefined && evidence.qualityPolicyVersion !== ELIGIBILITY_POLICY_VERSION) return false;
  if (evidence.qualityConfigVersion !== undefined && evidence.qualityConfigVersion !== QUALITY_CONFIG_VERSION) return false;
  return true;
}

export function isEligibilitySnapshotCurrent(evidence: QualitySnapshotEvidence, policyIds: readonly EligibilityPolicyId[] = POLICY_IDS): boolean {
  return (
    isQualitySnapshotCurrent(evidence) &&
    evidence.eligibility != null &&
    policyIds.every((policyId) => {
      const decision = evidence.eligibility?.[policyId];
      return decision?.policyId === policyId && decision.policyVersion === ELIGIBILITY_POLICY_VERSION;
    })
  );
}

const LAP_COMPARISON_CHANNELS = ["timing.distance-traveled", "motion.speed"] as const satisfies readonly TelemetryVariableId[];

const CORNER_TRACE_CHANNELS = ["timing.distance-traveled", "motion.speed", "inputs.accel", "inputs.brake", "inputs.steer"] as const satisfies readonly TelemetryVariableId[];

const TRANSIENT_CHANNELS = ["tires.tire-slip-ratio", "tires.tire-slip-angle", "tires.wheel-rotation-speed", "suspension.norm-suspension-travel"] as const satisfies readonly TelemetryVariableId[];

const ML_CHANNELS = CORNER_TRACE_CHANNELS;

const INTERRUPTING_TIMELINE_REASON_CODES = ["telemetry_gap_major", "timeline_discontinuity", "out_of_order_observations", "writer_drop"] as const satisfies readonly QualityReasonCode[];

export const QUALITY_POLICY_CONFIG_V1 = {
  version: QUALITY_CONFIG_VERSION,
  thresholds: QUALITY_THRESHOLDS_V1,
  requiredChannels: {
    "official-timing": [],
    "normal-pace": [],
    "lap-comparison": LAP_COMPARISON_CHANNELS,
    "corner-trace": CORNER_TRACE_CHANNELS,
    "transient-event": TRANSIENT_CHANNELS,
    "fuel-burn": ["fuel.fuel"],
    "tire-analysis": ["tire.temperature.average", "tires.tire-wear"],
    "stint-falloff": [],
    "setup-analysis": [],
    "driver-profile": [],
    "ml-training": ML_CHANNELS,
  },
  tireAnalysisCoverage: 1,
  minimumLapPools: {
    "stint-falloff": 3,
    "setup-analysis": 3,
    "driver-profile": 5,
  },
  setupCoefficientOfVariation: {
    eligibleMax: 0.02,
    warningMax: 0.04,
  },
  driverProfileCombinationCap: 20,
  sourceTreatmentConfidence: {
    direct: 1,
    held: 0.9,
    resampled: 0.8,
    "dead-reckoned": 0.65,
    assumed: 0.6,
    absent: 0,
  },
  mappingConfidence: {
    direct: 1,
    normalized: 1,
    simplified: 0.75,
    derived: 0.65,
    unavailable: 0,
  },
} as const;

export function rangesOverlap(left: QualityDistanceRange, right: QualityDistanceRange): boolean {
  return left.startFraction <= right.endFraction && right.startFraction <= left.endFraction;
}

export function overlapFraction(left: QualityDistanceRange, right: QualityDistanceRange): number {
  const start = Math.max(left.startFraction, right.startFraction);
  const end = Math.min(left.endFraction, right.endFraction);
  return Math.max(0, end - start);
}

export function qualityFactOverlapsRange(fact: Pick<QualityFact, "distanceRange">, range?: QualityDistanceRange): boolean {
  if (!range || !fact.distanceRange) return true;
  return rangesOverlap(fact.distanceRange, range);
}

function issueOverlapsRange(issue: ChannelIssueInterval, range?: QualityDistanceRange): boolean {
  if (!range || !issue.distanceRange) return true;
  return rangesOverlap(issue.distanceRange, range);
}

function channelById(quality: LapQualitySummary, semanticId: TelemetryVariableId): ChannelQualitySummary | undefined {
  return quality.channelQuality.find((channel) => channel.semanticId === semanticId);
}

function rangeCoverage(channel: ChannelQualitySummary | undefined, range?: QualityDistanceRange): number | null {
  if (!channel || channel.coverage == null) return null;
  if (!range) return channel.coverage;
  const rangeWidth = range.endFraction - range.startFraction;
  const issues = channel.issueIntervals;
  if (issues.length === 0 || issues.some((issue) => issue.distanceRange == null)) {
    return channel.coverage;
  }
  if (rangeWidth === 0) {
    return issues.some((issue) => rangesOverlap(issue.distanceRange!, range)) ? 0 : 1;
  }
  if (rangeWidth < 0) return null;
  let unavailableWidth = 0;
  let pointMissingCount = 0;
  for (const issue of issues) {
    const overlap = overlapFraction(issue.distanceRange!, range);
    if (overlap > 0) {
      unavailableWidth += overlap;
    } else if (issue.state === "missing" && rangesOverlap(issue.distanceRange!, range)) {
      pointMissingCount += issue.count;
    }
  }
  const unavailableFraction = Math.min(1, unavailableWidth / rangeWidth);
  const expectedRangeSamples = Math.max(1, channel.expectedCount * rangeWidth);
  const pointMissingFraction = Math.min(1, pointMissingCount / expectedRangeSamples);
  return Math.max(0, 1 - Math.min(1, unavailableFraction + pointMissingFraction));
}

function reasonFromFact(fact: QualityFact): EligibilityReason {
  return {
    code: fact.code,
    severity: fact.severity,
    evidenceIds: [fact.id],
    timeRange: fact.timeRange,
    distanceRange: fact.distanceRange ?? null,
    semanticIds: [...fact.semanticIds],
  };
}

function syntheticReason(code: QualityReasonCode, semanticIds: readonly TelemetryVariableId[] = []): EligibilityReason {
  return {
    code,
    severity: QUALITY_REASON_META[code].defaultSeverity,
    evidenceIds: [],
    timeRange: null,
    distanceRange: null,
    semanticIds: [...semanticIds],
  };
}

function dedupeReasons(reasons: readonly EligibilityReason[]): EligibilityReason[] {
  const seen = new Set<string>();
  const result: EligibilityReason[] = [];
  for (const reason of reasons) {
    const key = JSON.stringify([reason.code, [...reason.semanticIds].sort(), reason.timeRange, reason.distanceRange, [...reason.evidenceIds].sort()]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reason);
  }
  return result;
}

function unresolvedDecision(
  policyId: EligibilityPolicyId,
  reasons: readonly EligibilityReason[],
  policyVersion: string = ELIGIBILITY_POLICY_VERSION,
): EligibilityDecision {
  const uniqueReasons = dedupeReasons(reasons);
  return {
    status: "unknown",
    policyId,
    policyVersion,
    confidence: { level: "unknown", score: null },
    reasons: uniqueReasons,
    evidenceIds: [...new Set(uniqueReasons.flatMap(({ evidenceIds }) => evidenceIds))],
  };
}

const SOURCE_FIDELITY_REASON_CODES = new Set<QualityReasonCode>(["channel_simplified", "channel_derived", "pit_only_updates", "interpolated_channel", "fallback_channel"]);

function sourceFidelityReason(channel: ChannelQualitySummary, code: QualityReasonCode): EligibilityReason {
  const reason = syntheticReason(code, [channel.semanticId]);
  if (channel.sourceProfile) reason.evidenceIds.push(channel.sourceProfile.evidenceId);
  return reason;
}

function sourceFidelityReasons(quality: LapQualitySummary, requiredChannels: readonly TelemetryVariableId[], includeCatalogFidelity = false): EligibilityReason[] {
  const reasons: EligibilityReason[] = [];
  for (const semanticId of requiredChannels) {
    const channel = channelById(quality, semanticId);
    if (!channel) continue;
    if (channel.sourceProfile || includeCatalogFidelity) {
      if (channel.mappingStatus === "simplified") reasons.push(sourceFidelityReason(channel, "channel_simplified"));
      if (channel.mappingStatus === "derived") reasons.push(sourceFidelityReason(channel, "channel_derived"));
      if (channel.limitations.some((limitation) => /pit[- ]?(only|snapshot)/i.test(limitation))) {
        reasons.push(sourceFidelityReason(channel, "pit_only_updates"));
      }
      if (channel.limitations.some((limitation) => /interpolat/i.test(limitation))) {
        reasons.push(sourceFidelityReason(channel, "interpolated_channel"));
      }
      if (channel.limitations.some((limitation) => /fallback/i.test(limitation))) {
        reasons.push(sourceFidelityReason(channel, "fallback_channel"));
      }
    }
    switch (channel.sourceProfile?.treatment) {
      case "held":
      case "assumed":
        reasons.push(sourceFidelityReason(channel, "channel_simplified"));
        break;
      case "resampled":
        reasons.push(sourceFidelityReason(channel, "interpolated_channel"));
        break;
      case "dead-reckoned":
        reasons.push(sourceFidelityReason(channel, "channel_derived"));
        break;
    }
  }
  return dedupeReasons(reasons);
}

function sourceFidelityBlocksStrictAnalysis(quality: LapQualitySummary, reason: EligibilityReason): boolean {
  const channel = reason.semanticIds[0] ? channelById(quality, reason.semanticIds[0]) : undefined;
  const treatment = channel?.sourceProfile?.treatment;
  if (treatment && treatment !== "direct") return true;
  return channel?.mappingStatus === "simplified" || reason.code === "pit_only_updates" || reason.code === "interpolated_channel" || reason.code === "fallback_channel";
}

function channelFidelityFactor(channel: ChannelQualitySummary): number {
  const mappingFactor = QUALITY_POLICY_CONFIG_V1.mappingConfidence[channel.mappingStatus];
  const treatment = channel.sourceProfile?.treatment;
  const treatmentFactor = treatment ? QUALITY_POLICY_CONFIG_V1.sourceTreatmentConfidence[treatment] : 1;
  return Math.min(mappingFactor, treatmentFactor);
}

function factsFor(quality: LapQualitySummary, codes: readonly QualityReasonCode[], range?: QualityDistanceRange): QualityFact[] {
  const codeSet = new Set<QualityReasonCode>(codes);
  return quality.facts.filter((fact) => codeSet.has(fact.code) && qualityFactOverlapsRange(fact, range));
}

function lifecycleFactor(quality: LapQualitySummary): number {
  switch (quality.lifecycleState) {
    case "exact":
      return 1;
    case "minor_gaps":
      return 0.9;
    case "degraded":
      return 0.6;
    case "incomplete":
      return 0.25;
    default:
      return 0;
  }
}

function confidenceFor(quality: LapQualitySummary, requiredChannels: readonly TelemetryVariableId[], range: QualityDistanceRange | undefined, hasWarning: boolean): EligibilityDecision["confidence"] {
  const lifecycle = lifecycleFactor(quality);
  let channelScore = 1;
  for (const semanticId of requiredChannels) {
    const channel = channelById(quality, semanticId);
    const coverage = rangeCoverage(channel, range);
    if (coverage == null || channel?.confidenceMean == null) {
      return { level: "unknown", score: null };
    }
    channelScore = Math.min(channelScore, coverage * channel.confidenceMean * channelFidelityFactor(channel));
  }
  let score = channelScore * lifecycle;
  if (hasWarning) score = Math.min(score, 0.84);
  return {
    score,
    level: score >= 0.85 ? "high" : score >= 0.65 ? "medium" : "low",
  };
}

function decision(
  policyId: EligibilityPolicyId,
  quality: LapQualitySummary,
  status: EligibilityStatus,
  reasons: readonly EligibilityReason[],
  requiredChannels: readonly TelemetryVariableId[] = [],
  range?: QualityDistanceRange,
): EligibilityDecision {
  const uniqueReasons = dedupeReasons(reasons);
  return {
    status,
    policyId,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    confidence: confidenceFor(quality, requiredChannels, range, status === "eligible_with_warning" || uniqueReasons.some(({ severity }) => severity === "warning")),
    reasons: uniqueReasons,
    evidenceIds: [...new Set(uniqueReasons.flatMap(({ evidenceIds }) => evidenceIds))],
  };
}

function unknownDecision(policyId: EligibilityPolicyId, quality: LapQualitySummary, code: QualityReasonCode): EligibilityDecision {
  return decision(policyId, quality, "unknown", [syntheticReason(code)]);
}

function sourceUnavailableDecision(policyId: EligibilityPolicyId, quality: LapQualitySummary): EligibilityDecision | null {
  const lifecycleReason: Partial<Record<LapQualitySummary["lifecycleState"], QualityReasonCode>> = {
    unavailable: "recording_unavailable",
    incompatible: "recording_incompatible",
    corrupt: "recording_corrupt",
  };
  const code = lifecycleReason[quality.lifecycleState];
  return code ? unknownDecision(policyId, quality, code) : null;
}

function officialTiming(quality: LapQualitySummary): EligibilityDecision {
  if (!quality.complete) {
    const reasons = factsFor(quality, ["partial_lap", "recording_incomplete"]).map(reasonFromFact);
    return decision("official-timing", quality, "ineligible", reasons.length > 0 ? reasons : [syntheticReason("partial_lap")]);
  }
  if (quality.timing.source === "estimated") {
    return decision("official-timing", quality, "ineligible", [syntheticReason("lap_time_unconfirmed")]);
  }
  if (quality.timing.source === "telemetry-elapsed") {
    const reasons = factsFor(quality, ["lap_time_fallback"]).map(reasonFromFact);
    return decision("official-timing", quality, "eligible_with_warning", reasons.length > 0 ? reasons : [syntheticReason("lap_time_fallback")]);
  }
  if (!quality.timing.confirmed) {
    const reasons = factsFor(quality, ["lap_time_unconfirmed"]).map(reasonFromFact);
    return decision("official-timing", quality, "ineligible", reasons.length > 0 ? reasons : [syntheticReason("lap_time_unconfirmed")]);
  }
  return decision("official-timing", quality, "eligible", []);
}

function normalPace(quality: LapQualitySummary, range?: QualityDistanceRange): EligibilityDecision {
  const timing = officialTiming(quality);
  const reasons: EligibilityReason[] = [];
  if (!isEligibilityUsable(timing)) reasons.push(...timing.reasons);
  if (!quality.structurallyValid) {
    const structural = factsFor(quality, ["structurally_invalid"], range).map(reasonFromFact);
    reasons.push(...(structural.length > 0 ? structural : [syntheticReason("structurally_invalid")]));
  }
  if (quality.classification.paceEligibility !== "eligible") {
    const classification = factsFor(quality, ["non_pace_classification", "caution_context"], range).map(reasonFromFact);
    reasons.push(...(classification.length > 0 ? classification : [syntheticReason("non_pace_classification")]));
  }
  const incidents = factsFor(quality, ["incident_lap"], range).map(reasonFromFact);
  reasons.push(...incidents);
  const majorGaps = factsFor(quality, INTERRUPTING_TIMELINE_REASON_CODES, range).map(reasonFromFact);
  reasons.push(...majorGaps);
  if (reasons.length > 0) return decision("normal-pace", quality, "ineligible", reasons, [], range);

  const warnings = [...(timing.status === "eligible_with_warning" ? timing.reasons : []), ...factsFor(quality, ["telemetry_gap_minor", "source_reconnect"], range).map(reasonFromFact)];
  return decision("normal-pace", quality, warnings.length > 0 ? "eligible_with_warning" : "eligible", warnings, [], range);
}

function channelCoverageReasons(quality: LapQualitySummary, requiredChannels: readonly TelemetryVariableId[], minimumCoverage: number, range?: QualityDistanceRange): EligibilityReason[] {
  const reasons: EligibilityReason[] = [];
  for (const semanticId of requiredChannels) {
    const channel = channelById(quality, semanticId);
    const coverage = rangeCoverage(channel, range);
    if (!channel || channel.mappingStatus === "unavailable") {
      reasons.push(syntheticReason("channel_unavailable", [semanticId]));
    } else if (coverage == null || coverage < minimumCoverage) {
      reasons.push(syntheticReason("channel_missing", [semanticId]));
    }
    const overlappingIssues = channel?.issueIntervals.filter((issue) => issueOverlapsRange(issue, range)) ?? [];
    if (overlappingIssues.some(({ state }) => state === "stale")) reasons.push(syntheticReason("channel_stale", [semanticId]));
    if (overlappingIssues.some(({ state }) => state === "invalid" || state === "error")) reasons.push(syntheticReason("channel_invalid", [semanticId]));
  }
  return reasons;
}

function lapComparison(quality: LapQualitySummary, range?: QualityDistanceRange): EligibilityDecision {
  const timing = officialTiming(quality);
  const reasons: EligibilityReason[] = [];
  if (!isEligibilityUsable(timing)) reasons.push(...timing.reasons);
  if (!quality.structurallyValid) reasons.push(syntheticReason("structurally_invalid"));
  reasons.push(...channelCoverageReasons(quality, LAP_COMPARISON_CHANNELS, QUALITY_THRESHOLDS_V1.lapComparisonCoverage, range));
  const fidelityReasons = sourceFidelityReasons(quality, LAP_COMPARISON_CHANNELS);
  const majorGap = factsFor(quality, INTERRUPTING_TIMELINE_REASON_CODES, range)
    .filter((fact) => fact.code !== "telemetry_gap_major" || (fact.timeRange?.endMs ?? 0) - (fact.timeRange?.startMs ?? 0) > QUALITY_THRESHOLDS_V1.lapComparisonGapMaxMs)
    .map(reasonFromFact);
  reasons.push(...majorGap);
  if (reasons.length > 0) {
    return decision("lap-comparison", quality, "ineligible", reasons, LAP_COMPARISON_CHANNELS, range);
  }
  const warnings = [
    ...(timing.status === "eligible_with_warning" ? timing.reasons : []),
    ...factsFor(quality, ["non_pace_classification", "telemetry_gap_minor", "source_reconnect"], range).map(reasonFromFact),
    ...fidelityReasons,
  ];
  return decision("lap-comparison", quality, warnings.length > 0 ? "eligible_with_warning" : "eligible", warnings, LAP_COMPARISON_CHANNELS, range);
}

function cornerTrace(quality: LapQualitySummary, range?: QualityDistanceRange): EligibilityDecision {
  const comparison = lapComparison(quality, range);
  const reasons: EligibilityReason[] = [];
  if (!isEligibilityUsable(comparison)) reasons.push(...comparison.reasons);
  reasons.push(...channelCoverageReasons(quality, CORNER_TRACE_CHANNELS, QUALITY_THRESHOLDS_V1.cornerTraceCoverage, range));
  const fidelityReasons = sourceFidelityReasons(quality, CORNER_TRACE_CHANNELS);
  const blockingFidelityReasons = fidelityReasons.filter((reason) => sourceFidelityBlocksStrictAnalysis(quality, reason));
  reasons.push(...blockingFidelityReasons);
  const interrupted = factsFor(quality, ["telemetry_gap_major", "timeline_discontinuity"], range)
    .filter((fact) => fact.code === "timeline_discontinuity" || (fact.timeRange?.endMs ?? 0) - (fact.timeRange?.startMs ?? 0) > QUALITY_THRESHOLDS_V1.cornerTraceGapMaxMs)
    .map(reasonFromFact);
  reasons.push(...interrupted);
  const distance = channelById(quality, "timing.distance-traveled");
  const distanceAvailable = (rangeCoverage(distance, range) ?? 0) >= QUALITY_THRESHOLDS_V1.cornerTraceCoverage;
  if (!distanceAvailable && (quality.worldPositionCoverage ?? 0) === 0) reasons.push(syntheticReason("position_unavailable"));
  if (reasons.length > 0) return decision("corner-trace", quality, "ineligible", reasons, CORNER_TRACE_CHANNELS, range);

  const warnings = [...(comparison.status === "eligible_with_warning" ? comparison.reasons : []), ...fidelityReasons.filter((reason) => !blockingFidelityReasons.includes(reason))];
  if ((quality.worldPositionCoverage ?? 0) === 0 && distanceAvailable) warnings.push(syntheticReason("position_unavailable"));
  return decision("corner-trace", quality, warnings.length > 0 ? "eligible_with_warning" : "eligible", warnings, CORNER_TRACE_CHANNELS, range);
}

function transientEvent(quality: LapQualitySummary, options: EligibilityEvaluationOptions): EligibilityDecision {
  const range = options.range;
  const requiredChannels = options.requiredSemanticIds ?? TRANSIENT_CHANNELS;
  const reasons = [...channelCoverageReasons(quality, requiredChannels, QUALITY_THRESHOLDS_V1.transientCoverage, range), ...sourceFidelityReasons(quality, requiredChannels, true)];
  let inferredIntervalMs = 0;
  for (const semanticId of requiredChannels) {
    const channel = channelById(quality, semanticId);
    inferredIntervalMs = Math.max(inferredIntervalMs, channel?.expectedCadenceMs ?? 0);
  }
  const maximumGapMs = Math.max(QUALITY_THRESHOLDS_V1.transientGapFloorMs, QUALITY_THRESHOLDS_V1.transientIntervalMultiplier * inferredIntervalMs);
  reasons.push(
    ...factsFor(quality, ["telemetry_gap_minor", "telemetry_gap_major", "timeline_discontinuity", "source_reconnect", "out_of_order_observations", "writer_drop"], range)
      .filter((fact) => (fact.code !== "telemetry_gap_minor" && fact.code !== "telemetry_gap_major" ? true : (fact.timeRange?.endMs ?? 0) - (fact.timeRange?.startMs ?? 0) > maximumGapMs))
      .map(reasonFromFact),
  );
  return decision("transient-event", quality, reasons.length > 0 ? "ineligible" : "eligible", reasons, requiredChannels, range);
}

function fuelBurn(quality: LapQualitySummary): EligibilityDecision {
  const fuel = channelById(quality, "fuel.fuel");
  const reasons: EligibilityReason[] = [];
  if (!quality.complete) {
    const partial = factsFor(quality, ["partial_lap"]).map(reasonFromFact);
    reasons.push(...(partial.length > 0 ? partial : [syntheticReason("partial_lap")]));
  }
  if (!fuel || fuel.mappingStatus === "unavailable") reasons.push(syntheticReason("channel_unavailable", ["fuel.fuel"]));
  else {
    if (fuel.boundaryCoverage.first500Ms == null || fuel.boundaryCoverage.first500Ms < 1 || fuel.boundaryCoverage.last500Ms == null || fuel.boundaryCoverage.last500Ms < 1) {
      reasons.push(syntheticReason("channel_missing", ["fuel.fuel"]));
    }
    if (fuel.freshnessCounts.stale > 0) reasons.push(syntheticReason("channel_stale", ["fuel.fuel"]));
    if (fuel.resolutionCounts.invalid > 0 || fuel.resolutionCounts.error > 0) reasons.push(syntheticReason("channel_invalid", ["fuel.fuel"]));
  }
  if (reasons.length > 0) return decision("fuel-burn", quality, "ineligible", reasons, ["fuel.fuel"]);
  const warnings = [...factsFor(quality, ["caution_context", "incident_lap"]).map(reasonFromFact), ...sourceFidelityReasons(quality, ["fuel.fuel"])];
  return decision("fuel-burn", quality, warnings.length > 0 ? "eligible_with_warning" : "eligible", warnings, ["fuel.fuel"]);
}

function tireAnalysis(quality: LapQualitySummary, tireMode: EligibilityEvaluationOptions["tireMode"] = "continuous"): EligibilityDecision {
  const requiredChannels = QUALITY_POLICY_CONFIG_V1.requiredChannels["tire-analysis"];
  const reasons: EligibilityReason[] = [];
  const warnings: EligibilityReason[] = [];
  const continuous = tireMode === "continuous";
  for (const semanticId of requiredChannels) {
    const channel = channelById(quality, semanticId);
    if (!channel || channel.mappingStatus === "unavailable") {
      reasons.push(syntheticReason("channel_unavailable", [semanticId]));
      continue;
    }
    const pitOnly = channel.limitations.some((limitation) => /pit[- ]?(only|snapshot)/i.test(limitation));
    if (continuous && pitOnly) reasons.push(syntheticReason("pit_only_updates", [semanticId]));
    if (!continuous && pitOnly && channel.observedCount === 0) reasons.push(syntheticReason("channel_missing", [semanticId]));
    if (continuous) {
      if (channel.coverage == null || channel.coverage < QUALITY_POLICY_CONFIG_V1.tireAnalysisCoverage) reasons.push(syntheticReason("channel_missing", [semanticId]));
      if (channel.resolutionCounts.missing > 0) reasons.push(syntheticReason("channel_missing", [semanticId]));
      if (channel.resolutionCounts.invalid > 0 || channel.resolutionCounts.error > 0) reasons.push(syntheticReason("channel_invalid", [semanticId]));
    }
    if (channel.freshnessCounts.stale > 0) reasons.push(syntheticReason("channel_stale", [semanticId]));
  }
  warnings.push(...sourceFidelityReasons(quality, requiredChannels));
  if (reasons.length > 0) return decision("tire-analysis", quality, "ineligible", reasons, requiredChannels);
  return decision("tire-analysis", quality, warnings.length > 0 ? "eligible_with_warning" : "eligible", warnings, requiredChannels);
}

function mlTraining(quality: LapQualitySummary, options: EligibilityEvaluationOptions): EligibilityDecision {
  const requiredChannels = options.requiredSemanticIds ?? ML_CHANNELS;
  const reasons: EligibilityReason[] = [];
  if (!quality.structurallyValid) {
    const structural = factsFor(quality, ["structurally_invalid"]).map(reasonFromFact);
    reasons.push(...(structural.length > 0 ? structural : [syntheticReason("structurally_invalid")]));
  }
  if (quality.lifecycleState !== "exact" && quality.lifecycleState !== "minor_gaps") {
    reasons.push(syntheticReason(quality.lifecycleState === "incomplete" ? "recording_incomplete" : "telemetry_gap_major"));
  }
  if (quality.participant.identityState !== "stable" || !quality.participant.stableId) {
    reasons.push(syntheticReason("identity_unstable"));
  }
  const provenance = quality.provenance;
  if (
    !provenance.schemaVersion ||
    !provenance.policyVersion ||
    !provenance.configurationVersion ||
    !provenance.sourceGeneration ||
    provenance.sourceGeneration === "legacy" ||
    provenance.sourceGeneration.startsWith("provisional:")
  )
    reasons.push(syntheticReason("provenance_missing"));
  for (const semanticId of requiredChannels) {
    const channel = channelById(quality, semanticId);
    if (!channel || channel.coverage == null || channel.coverage < 1) {
      reasons.push(syntheticReason("channel_missing", [semanticId]));
      continue;
    }
    if (channel.freshnessCounts.stale > 0 || channel.freshnessCounts.unknown > 0) {
      reasons.push(syntheticReason("channel_stale", [semanticId]));
    }
  }
  reasons.push(...sourceFidelityReasons(quality, requiredChannels, true));
  reasons.push(...quality.facts.filter((fact) => fact.severity === "warning" && fact.code !== "imported_source" && !SOURCE_FIDELITY_REASON_CODES.has(fact.code)).map(reasonFromFact));
  return decision("ml-training", quality, reasons.length > 0 ? "ineligible" : "eligible", reasons, requiredChannels, options.range);
}

export function evaluateEligibility(policyId: EligibilityPolicyId, evidence: LapQualitySummary, options: EligibilityEvaluationOptions = {}): EligibilityDecision {
  const unavailable = sourceUnavailableDecision(policyId, evidence);
  if (unavailable) return unavailable;
  switch (policyId) {
    case "official-timing":
      return officialTiming(evidence);
    case "normal-pace":
      return normalPace(evidence, options.range);
    case "lap-comparison":
      return lapComparison(evidence, options.range);
    case "corner-trace":
      return cornerTrace(evidence, options.range);
    case "transient-event":
      return transientEvent(evidence, options);
    case "fuel-burn":
      return fuelBurn(evidence);
    case "tire-analysis":
      return tireAnalysis(evidence, options.tireMode);
    case "ml-training":
      return mlTraining(evidence, options);
    case "stint-falloff":
    case "setup-analysis":
    case "driver-profile":
      return unknownDecision(policyId, evidence, "insufficient_sample_pool");
  }
}

export function evaluateAllEligibility(evidence: LapQualitySummary): EligibilityDecisionSet {
  return Object.fromEntries(POLICY_IDS.map((policyId) => [policyId, evaluateEligibility(policyId, evidence)])) as EligibilityDecisionSet;
}

function groupDecision(
  policyId: "stint-falloff" | "setup-analysis" | "driver-profile",
  laps: readonly GroupEligibilityLap[],
  status: EligibilityStatus,
  reasons: readonly EligibilityReason[],
): EligibilityDecision {
  const quality = laps[0]?.quality;
  if (!quality) {
    return unresolvedDecision(policyId, reasons.length > 0 ? reasons : [syntheticReason("insufficient_sample_pool")]);
  }
  const confidenceScores = laps.map((lap) => lap.eligibility[policyId]?.confidence.score).filter((score): score is number => score != null);
  const result = decision(policyId, quality, status, reasons);
  if (confidenceScores.length !== laps.length) result.confidence = { level: "unknown", score: null };
  else if (confidenceScores.length > 0) {
    const score = Math.min(...confidenceScores, result.confidence.score ?? 1);
    result.confidence = { score, level: score >= 0.85 ? "high" : score >= 0.65 ? "medium" : "low" };
  }
  return result;
}

export function selectDriverProfileEligibleLaps(laps: readonly GroupEligibilityLap[], context: Pick<GroupEligibilityContext, "newestFirst"> = {}): GroupEligibilityLap[] {
  const sorted = context.newestFirst ? [...laps] : [...laps].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  const perCombination: Record<string, number> = {};
  return sorted.filter((lap) => {
    if (!isEligibilityUsable(lap.eligibility["normal-pace"]) || !isEligibilityUsable(lap.eligibility["lap-comparison"])) return false;
    const key = lap.carTrackKey ?? "unknown";
    perCombination[key] = (perCombination[key] ?? 0) + 1;
    return perCombination[key] <= QUALITY_POLICY_CONFIG_V1.driverProfileCombinationCap;
  });
}

export function evaluateGroupEligibility(policyId: EligibilityPolicyId, laps: readonly GroupEligibilityLap[], context: GroupEligibilityContext = {}): EligibilityDecision {
  if (policyId === "stint-falloff") {
    if (!context.paceSegmentId) return groupDecision(policyId, laps, "unknown", [syntheticReason("pace_segment_missing")]);
    const usable = laps.filter(
      (lap) => isEligibilityUsable(lap.eligibility["normal-pace"]) && !lap.quality.facts.some(({ code }) => code === "caution_context" || code === "traffic_context" || code === "incident_lap"),
    );
    if (usable.length < QUALITY_POLICY_CONFIG_V1.minimumLapPools[policyId]) {
      return groupDecision(policyId, usable, "ineligible", [syntheticReason("insufficient_sample_pool")]);
    }
    return groupDecision(policyId, usable, "eligible", []);
  }

  if (policyId === "setup-analysis") {
    const usable = laps.filter((lap) => isEligibilityUsable(lap.eligibility["normal-pace"]) && isEligibilityUsable(lap.eligibility["corner-trace"]));
    if (usable.length < QUALITY_POLICY_CONFIG_V1.minimumLapPools[policyId]) {
      return groupDecision(policyId, usable, "unknown", [syntheticReason("insufficient_sample_pool")]);
    }
    const warnings = dedupeReasons(
      usable.flatMap((lap) =>
        (["normal-pace", "corner-trace"] as const).flatMap((lapPolicyId) => {
          const lapDecision = lap.eligibility[lapPolicyId];
          return lapDecision.status === "eligible_with_warning" ? lapDecision.reasons : [];
        }),
      ),
    );
    const mean = usable.reduce((sum, lap) => sum + lap.lapTime, 0) / usable.length;
    const variance = usable.reduce((sum, lap) => sum + (lap.lapTime - mean) ** 2, 0) / usable.length;
    const coefficient = mean > 0 ? Math.sqrt(variance) / mean : Infinity;
    if (coefficient <= QUALITY_POLICY_CONFIG_V1.setupCoefficientOfVariation.eligibleMax) {
      return groupDecision(policyId, usable, warnings.length > 0 ? "eligible_with_warning" : "eligible", warnings);
    }
    const inconsistent = syntheticReason("driver_inconsistent");
    if (coefficient <= QUALITY_POLICY_CONFIG_V1.setupCoefficientOfVariation.warningMax) {
      return groupDecision(policyId, usable, "eligible_with_warning", [...warnings, inconsistent]);
    }
    return groupDecision(policyId, usable, "ineligible", [...warnings, inconsistent]);
  }

  if (policyId === "driver-profile") {
    const usable = selectDriverProfileEligibleLaps(laps, context);
    if (usable.length < QUALITY_POLICY_CONFIG_V1.minimumLapPools[policyId]) {
      return groupDecision(policyId, usable, "unknown", [syntheticReason("insufficient_sample_pool")]);
    }
    const combinations = context.combinationCount ?? new Set(usable.map((lap) => lap.carTrackKey ?? "unknown")).size;
    return groupDecision(policyId, usable, combinations <= 1 ? "eligible_with_warning" : "eligible", combinations <= 1 ? [syntheticReason("insufficient_sample_pool")] : []);
  }

  const first = laps[0];
  if (!first) return unresolvedDecision(policyId, [syntheticReason("insufficient_sample_pool")]);
  return first.eligibility[policyId];
}

export function isEligibilityUsable(decision: EligibilityDecision | null | undefined): boolean {
  return decision?.status === "eligible" || decision?.status === "eligible_with_warning";
}

export function isTimedLapEligibilityUsable(
  evidence: QualitySnapshotEvidence & {
    lapTime: number;
  },
  policyId: EligibilityPolicyId = "normal-pace",
): boolean {
  return Number.isFinite(evidence.lapTime) && evidence.lapTime > 0 && isEligibilityUsable(resolveEligibilityDecision(evidence, policyId));
}

export function replaceWithUnknownEligibilityDecision(
  current: Pick<EligibilityDecision, "policyId" | "policyVersion">,
  code: QualityReasonCode,
  semanticIds: readonly TelemetryVariableId[] = [],
): EligibilityDecision {
  return unresolvedDecision(current.policyId, [syntheticReason(code, semanticIds)], current.policyVersion);
}

export function resolveEligibilityDecision(
  evidence: QualitySnapshotEvidence & { quality?: LapQualitySummary | null },
  policyId: EligibilityPolicyId,
  options: EligibilityEvaluationOptions = {},
): EligibilityDecision {
  const snapshotCurrent = isQualitySnapshotCurrent(evidence);
  const persisted = evidence.eligibility?.[policyId];
  if (snapshotCurrent && persisted?.policyId === policyId && persisted.policyVersion === ELIGIBILITY_POLICY_VERSION) return persisted;
  if (snapshotCurrent && evidence.quality) return evaluateEligibility(policyId, evidence.quality, options);
  return unresolvedDecision(policyId, [syntheticReason("quality_not_rebuilt")]);
}

export function isEligibilityStrict(decision: EligibilityDecision | null | undefined): boolean {
  return decision?.status === "eligible";
}
