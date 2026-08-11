import type { GameId } from "@shared/games/ids";
import { getTelemetryVariable } from "@shared/telemetry/catalog/query";
import type { TelemetryGroupId, TelemetryVariableId } from "@shared/telemetry/catalog/generated/telemetry-catalog.types";
import { compileTelemetryResolver } from "@shared/telemetry/resolver/compile";
import type { CompiledTelemetryResolver, FreshnessState, ResolutionState, ResolvedValue, TelemetryFrameView } from "@shared/telemetry/resolver/contracts";
import type { TelemetryPacket } from "@shared/telemetry/types";
import type { TelemetryVersionIdentity } from "@shared/telemetry/version";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type ArchiveVerification,
  type ChannelIssueInterval,
  type ChannelQualitySummary,
  type EvidenceSourceKind,
  type GapSummary,
  type LapQualitySummary,
  type ParticipantEvidence,
  type QualityDistanceRange,
  type QualityFact,
  type QualityProvenance,
  type QualityReasonCode,
  type QualityThresholdSnapshot,
  type QualityTimeRange,
  type RecordingLifecycleState,
  type RecordingQualitySummary,
  type SourceLifecycleEvidence,
  type SourceChannelProfile,
} from "./contracts";
import type { LapClassification } from "../laps/classification";
import { QUALITY_REASON_META } from "./reasons";

export const QUALITY_THRESHOLDS_V1: QualityThresholdSnapshot = {
  minorGapMaxMs: 250,
  minorMissingFractionMax: 0.01,
  degradedMissingFraction: 0.05,
  lapComparisonCoverage: 0.95,
  lapComparisonGapMaxMs: 1_000,
  cornerTraceCoverage: 0.98,
  cornerTraceGapMaxMs: 250,
  transientCoverage: 0.995,
  transientGapFloorMs: 50,
  transientIntervalMultiplier: 2,
};

export const QUALITY_CHANNEL_IDS = [
  "timing.last-lap",
  "timing.current-lap",
  "timing.distance-traveled",
  "motion.position-x",
  "motion.position-z",
  "motion.speed",
  "inputs.accel",
  "inputs.brake",
  "inputs.steer",
  "fuel.fuel",
  "tire.temperature.average",
  "tires.tire-wear",
  "tires.tire-pressure",
  "tires.tire-slip-ratio",
  "tires.tire-slip-angle",
  "tires.wheel-rotation-speed",
  "suspension.norm-suspension-travel",
] as const satisfies readonly TelemetryVariableId[];

const OPPONENT_PLAYER_ONLY_CHANNELS: Partial<Record<TelemetryVariableId, true>> = {
  "inputs.accel": true,
  "inputs.brake": true,
  "inputs.steer": true,
  "fuel.fuel": true,
  "tire.temperature.average": true,
  "tires.tire-wear": true,
  "tires.tire-pressure": true,
  "tires.tire-slip-ratio": true,
  "tires.tire-slip-angle": true,
  "tires.wheel-rotation-speed": true,
  "suspension.norm-suspension-travel": true,
};

const resolverCache = new Map<GameId, CompiledTelemetryResolver>();

function resolverFor(gameId: GameId): CompiledTelemetryResolver {
  let resolver = resolverCache.get(gameId);
  if (!resolver) {
    resolver = compileTelemetryResolver({
      simulator: gameId,
      requested: QUALITY_CHANNEL_IDS.map((semanticId) => ({ semanticId })),
    });
    resolverCache.set(gameId, resolver);
  }
  return resolver;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function stableIdentity(identity: TelemetryVersionIdentity): string {
  return [identity.catalogVersion, identity.catalogHash, identity.catalogSchemaVersion, identity.parserVersion, identity.resolverVersion, identity.derivationVersion].join(":");
}

function baseProvenance(sourceKind: EvidenceSourceKind, participant: ParticipantEvidence, identity: TelemetryVersionIdentity): QualityProvenance {
  const participantId = participant.stableId ?? participant.sourceId ?? participant.identityState;
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    configurationVersion: QUALITY_CONFIG_VERSION,
    sourceGeneration: `provisional:${sourceKind}:${participantId}:${stableIdentity(identity)}`,
    outputGeneration: "provisional",
  };
}

function distanceFraction(packet: TelemetryPacket, minimumDistance: number, distanceSpan: number): number | null {
  const sdkFraction = packet.iracing?.lapDistancePct;
  if (typeof sdkFraction === "number" && Number.isFinite(sdkFraction)) {
    return clamp01(sdkFraction);
  }
  if (!Number.isFinite(packet.DistanceTraveled) || distanceSpan <= 0) return null;
  return clamp01((packet.DistanceTraveled - minimumDistance) / distanceSpan);
}

interface SequenceObservation {
  family: string;
  sequence: number;
}

function packetSequences(packet: TelemetryPacket): SequenceObservation[] {
  if (packet.iracing && Number.isFinite(packet.iracing.sessionTick)) {
    return [{ family: "iracing-session-tick", sequence: packet.iracing.sessionTick }];
  }
  if (packet.gameId === "f1-2025") {
    const overall = packet.f1?.overallFrameIdentifier;
    const packetId = packet.f1?.packetId;
    return typeof overall === "number" && typeof packetId === "number" ? [{ family: `f1-packet-${packetId}`, sequence: overall }] : [];
  }
  const physics = packet.acc?.physicsPacketId ?? packet.acc?.acEvo?.physicsPacketId;
  if (typeof physics === "number" && Number.isFinite(physics)) {
    return [{ family: "kunos-physics", sequence: physics }];
  }
  const graphics = packet.acc?.graphicsPacketId ?? packet.acc?.acEvo?.graphicsPacketId;
  return typeof graphics === "number" && Number.isFinite(graphics) ? [{ family: "kunos-graphics", sequence: graphics }] : [];
}

interface TimelineRangeEvidence {
  timeRange: QualityTimeRange;
  distanceRange: QualityDistanceRange | null;
}

interface GapEvidence extends TimelineRangeEvidence {
  durationMs: number;
  missingCount: number;
  method: GapSummary["countMethod"];
  family: string;
}

interface TimelineMeasurement {
  summary: GapSummary;
  gaps: GapEvidence[];
  duplicateCount: number;
  outOfOrder: TimelineRangeEvidence[];
  discontinuities: TimelineRangeEvidence[];
  inferredIntervalMs: number | null;
}

function timelineRangeEvidence(
  previous: TelemetryPacket,
  current: TelemetryPacket,
  minimumDistance: number,
  distanceSpan: number,
): TimelineRangeEvidence {
  const startFraction = distanceFraction(previous, minimumDistance, distanceSpan);
  const endFraction = distanceFraction(current, minimumDistance, distanceSpan);
  return {
    timeRange: {
      startMs: Math.min(previous.TimestampMS, current.TimestampMS),
      endMs: Math.max(previous.TimestampMS, current.TimestampMS),
    },
    distanceRange:
      startFraction == null || endFraction == null
        ? null
        : {
            startFraction: Math.min(startFraction, endFraction),
            endFraction: Math.max(startFraction, endFraction),
          },
  };
}

function measureTimeline(packets: readonly TelemetryPacket[]): TimelineMeasurement {
  if (packets.length === 0) {
    return {
      summary: {
        expectedCount: 0,
        observedCount: 0,
        totalMissingCount: null,
        totalMissingFraction: null,
        largestContiguousGapMs: 0,
        countMethod: "unavailable",
      },
      gaps: [],
      duplicateCount: 0,
      outOfOrder: [],
      discontinuities: [],
      inferredIntervalMs: null,
    };
  }

  const minimumDistance = Math.min(...packets.map((packet) => packet.DistanceTraveled).filter(Number.isFinite));
  const maximumDistance = Math.max(...packets.map((packet) => packet.DistanceTraveled).filter(Number.isFinite));
  const distanceSpan = Math.max(0, maximumDistance - minimumDistance);
  const positiveTimeDeltas: number[] = [];
  let duplicateCount = 0;
  for (let index = 1; index < packets.length; index += 1) {
    const delta = packets[index]!.TimestampMS - packets[index - 1]!.TimestampMS;
    if (delta > 0) positiveTimeDeltas.push(delta);
  }
  const inferredIntervalMs = median(positiveTimeDeltas);
  const discontinuities: TimelineRangeEvidence[] = [];
  if (inferredIntervalMs != null) {
    const discontinuityThresholdMs = Math.max(5_000, inferredIntervalMs * 100);
    for (let index = 1; index < packets.length; index += 1) {
      const previous = packets[index - 1]!;
      const current = packets[index]!;
      if (current.TimestampMS - previous.TimestampMS > discontinuityThresholdMs) {
        discontinuities.push(timelineRangeEvidence(previous, current, minimumDistance, distanceSpan));
      }
    }
  }

  const familyPackets = new Map<string, { sequence: number; packet: TelemetryPacket }[]>();
  for (const packet of packets) {
    for (const observation of packetSequences(packet)) {
      const family = familyPackets.get(observation.family) ?? [];
      family.push({ sequence: observation.sequence, packet });
      familyPackets.set(observation.family, family);
    }
  }
  const outOfOrder: TimelineRangeEvidence[] = [];
  if (familyPackets.size === 0) {
    for (let index = 1; index < packets.length; index += 1) {
      const previous = packets[index - 1]!;
      const current = packets[index]!;
      const delta = current.TimestampMS - previous.TimestampMS;
      if (delta === 0) duplicateCount += 1;
      else if (delta < 0) outOfOrder.push(timelineRangeEvidence(previous, current, minimumDistance, distanceSpan));
    }
  }

  const gaps: GapEvidence[] = [];
  let expectedCount = 0;
  let observedCount = 0;
  let missingCount = 0;
  if (familyPackets.size > 0) {
    for (const [familyName, observations] of familyPackets) {
      observedCount += observations.length;
      const positiveSteps: number[] = [];
      for (let index = 1; index < observations.length; index += 1) {
        const previous = observations[index - 1]!;
        const current = observations[index]!;
        const step = current.sequence - previous.sequence;
        if (step > 0) positiveSteps.push(step);
        else if (step === 0) duplicateCount += 1;
        else outOfOrder.push(timelineRangeEvidence(previous.packet, current.packet, minimumDistance, distanceSpan));
      }
      const expectedStep = median(positiveSteps) ?? 1;
      let familyMissing = 0;
      for (let index = 1; index < observations.length; index += 1) {
        const previous = observations[index - 1]!;
        const current = observations[index]!;
        const sequenceDelta = current.sequence - previous.sequence;
        if (sequenceDelta <= expectedStep) continue;
        const inferredMissing = Math.max(0, Math.round(sequenceDelta / expectedStep) - 1);
        if (inferredMissing === 0) continue;
        familyMissing += inferredMissing;
        gaps.push({
          ...timelineRangeEvidence(previous.packet, current.packet, minimumDistance, distanceSpan),
          durationMs: Math.max(0, current.packet.TimestampMS - previous.packet.TimestampMS),
          missingCount: inferredMissing,
          method: "native-sequence",
          family: familyName,
        });
      }
      missingCount += familyMissing;
      expectedCount += observations.length + familyMissing;
    }
    return {
      summary: {
        expectedCount,
        observedCount,
        totalMissingCount: missingCount,
        totalMissingFraction: expectedCount > 0 ? missingCount / expectedCount : 0,
        largestContiguousGapMs: gaps.reduce((largest, gap) => Math.max(largest, gap.durationMs), 0),
        countMethod: "native-sequence",
      },
      gaps,
      duplicateCount,
      outOfOrder,
      discontinuities,
      inferredIntervalMs,
    };
  }

  if (inferredIntervalMs == null || packets.length < 2) {
    return {
      summary: {
        expectedCount: packets.length,
        observedCount: packets.length,
        totalMissingCount: null,
        totalMissingFraction: null,
        largestContiguousGapMs: 0,
        countMethod: "unavailable",
      },
      gaps,
      duplicateCount,
      outOfOrder,
      discontinuities,
      inferredIntervalMs,
    };
  }

  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1]!;
    const current = packets[index]!;
    const delta = current.TimestampMS - previous.TimestampMS;
    const inferredMissing = Math.max(0, Math.round(delta / inferredIntervalMs) - 1);
    if (inferredMissing === 0) continue;
    gaps.push({
      ...timelineRangeEvidence(previous, current, minimumDistance, distanceSpan),
      durationMs: Math.max(0, delta),
      missingCount: inferredMissing,
      method: "timestamp-estimate",
      family: "timestamp",
    });
  }
  missingCount = gaps.reduce((sum, gap) => sum + gap.missingCount, 0);
  expectedCount = packets.length + missingCount;
  return {
    summary: {
      expectedCount,
      observedCount: packets.length,
      totalMissingCount: missingCount,
      totalMissingFraction: expectedCount > 0 ? missingCount / expectedCount : 0,
      largestContiguousGapMs: gaps.reduce((largest, gap) => Math.max(largest, gap.durationMs), 0),
      countMethod: "timestamp-estimate",
    },
    gaps,
    duplicateCount,
    outOfOrder,
    discontinuities,
    inferredIntervalMs,
  };
}

const RESOLUTION_STATES: readonly ResolutionState[] = ["ok", "missing", "stale", "invalid", "not-applicable", "error"];
const FRESHNESS_STATES: readonly FreshnessState[] = ["fresh", "stale", "unknown"];

function resolutionCounts(): Record<ResolutionState, number> {
  return Object.fromEntries(RESOLUTION_STATES.map((state) => [state, 0])) as Record<ResolutionState, number>;
}

function freshnessCounts(): Record<FreshnessState, number> {
  return Object.fromEntries(FRESHNESS_STATES.map((state) => [state, 0])) as Record<FreshnessState, number>;
}

interface ChannelAccumulator {
  summary: ChannelQualitySummary;
  confidenceSum: number;
  confidenceCount: number;
  observationTimes: number[];
  firstWindowCount: number;
  firstWindowOk: number;
  lastWindowCount: number;
  lastWindowOk: number;
  activeIssue: ChannelIssueInterval | null;
}

function createChannelAccumulator(semanticId: TelemetryVariableId, expectedCount: number): ChannelAccumulator {
  const definition = getTelemetryVariable(semanticId);
  return {
    summary: {
      semanticId,
      channelFamily: definition.parentId,
      mappingStatus: "unavailable",
      canonicalUnit: definition.canonicalUnit || null,
      nativeUnit: null,
      resolutionCounts: resolutionCounts(),
      freshnessCounts: freshnessCounts(),
      expectedCount,
      observedCount: 0,
      expectedCadenceMs: null,
      observedCadenceMs: null,
      coverage: null,
      confidenceMean: null,
      boundaryCoverage: { first500Ms: null, last500Ms: null },
      issueIntervals: [],
      limitations: [],
      provenance: null,
    },
    confidenceSum: 0,
    confidenceCount: 0,
    observationTimes: [],
    firstWindowCount: 0,
    firstWindowOk: 0,
    lastWindowCount: 0,
    lastWindowOk: 0,
    activeIssue: null,
  };
}

function isFiniteResolvedValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0 && value.every(isFiniteResolvedValue);
  return value != null;
}

function closeActiveIssue(accumulator: ChannelAccumulator): void {
  if (!accumulator.activeIssue) return;
  accumulator.summary.issueIntervals.push(accumulator.activeIssue);
  accumulator.activeIssue = null;
}

function observeChannel(accumulator: ChannelAccumulator, resolved: ResolvedValue<unknown>, packet: TelemetryPacket, lapStartMs: number, lapEndMs: number, fraction: number | null): void {
  const state = resolved.state === "ok" && !isFiniteResolvedValue(resolved.value) ? "invalid" : resolved.state;
  accumulator.summary.resolutionCounts[state] += 1;
  accumulator.summary.freshnessCounts[resolved.freshness] += 1;
  accumulator.summary.mappingStatus = resolved.mappingStatus;
  accumulator.summary.nativeUnit = resolved.provenance.sourceUnit ?? accumulator.summary.nativeUnit;
  const { observedAt: _observedAt, sourceObservation: _sourceObservation, ...stableProvenance } = resolved.provenance;
  accumulator.summary.provenance = stableProvenance;
  for (const limitation of resolved.limitations) {
    if (!accumulator.summary.limitations.includes(limitation)) accumulator.summary.limitations.push(limitation);
  }
  const usable = state === "ok" && resolved.freshness !== "stale";
  if (usable) {
    accumulator.summary.observedCount += 1;
    accumulator.observationTimes.push(packet.TimestampMS);
    if (resolved.confidence != null && Number.isFinite(resolved.confidence)) {
      accumulator.confidenceSum += resolved.confidence;
      accumulator.confidenceCount += 1;
    }
  }
  if (packet.TimestampMS - lapStartMs <= 500) {
    accumulator.firstWindowCount += 1;
    if (usable) accumulator.firstWindowOk += 1;
  }
  if (lapEndMs - packet.TimestampMS <= 500) {
    accumulator.lastWindowCount += 1;
    if (usable) accumulator.lastWindowOk += 1;
  }

  const issue = state !== "ok" || resolved.freshness === "stale";
  if (!issue) {
    closeActiveIssue(accumulator);
    return;
  }
  const currentRange = { startMs: packet.TimestampMS, endMs: packet.TimestampMS };
  const currentDistance = fraction == null ? null : { startFraction: fraction, endFraction: fraction };
  if (accumulator.activeIssue && accumulator.activeIssue.state === state && accumulator.activeIssue.freshness === resolved.freshness) {
    accumulator.activeIssue.timeRange.endMs = packet.TimestampMS;
    if (accumulator.activeIssue.distanceRange && currentDistance) {
      accumulator.activeIssue.distanceRange.endFraction = currentDistance.endFraction;
    }
    accumulator.activeIssue.count += 1;
  } else {
    closeActiveIssue(accumulator);
    accumulator.activeIssue = {
      state,
      freshness: resolved.freshness,
      timeRange: currentRange,
      distanceRange: currentDistance,
      count: 1,
    };
  }
}

function applySourceChannelProfile(summary: ChannelQualitySummary, profile?: SourceChannelProfile): void {
  const entry = profile?.channels[summary.semanticId];
  if (!entry) return;
  summary.mappingStatus = entry.mappingStatus;
  for (const limitation of entry.limitations) {
    if (!summary.limitations.includes(limitation)) summary.limitations.push(limitation);
  }
  if (entry.mappingStatus !== "unavailable") return;
  summary.observedCount = 0;
  summary.coverage = null;
  summary.confidenceMean = null;
  summary.boundaryCoverage.first500Ms = null;
  summary.boundaryCoverage.last500Ms = null;
  summary.issueIntervals = [];
  summary.resolutionCounts = resolutionCounts();
  summary.resolutionCounts["not-applicable"] = summary.expectedCount;
  summary.freshnessCounts = freshnessCounts();
}

function measureChannels(
  packets: readonly TelemetryPacket[],
  participant: ParticipantEvidence,
  inferredIntervalMs: number | null,
  expectedCount: number,
  sourceChannelProfile?: SourceChannelProfile,
): ChannelQualitySummary[] {
  if (packets.length === 0) {
    return QUALITY_CHANNEL_IDS.map((semanticId) => {
      const summary = createChannelAccumulator(semanticId, 0).summary;
      applySourceChannelProfile(summary, sourceChannelProfile);
      return summary;
    });
  }
  const resolver = resolverFor(packets[0]!.gameId);
  const slots = QUALITY_CHANNEL_IDS.map((semanticId) => resolver.slot(semanticId));
  const accumulators = QUALITY_CHANNEL_IDS.map((semanticId) => createChannelAccumulator(semanticId, expectedCount));
  const distances = packets.map((packet) => packet.DistanceTraveled).filter(Number.isFinite);
  const minimumDistance = distances.length > 0 ? Math.min(...distances) : 0;
  const maximumDistance = distances.length > 0 ? Math.max(...distances) : 0;
  const distanceSpan = Math.max(0, maximumDistance - minimumDistance);
  const lapStartMs = packets[0]!.TimestampMS;
  const lapEndMs = packets[packets.length - 1]!.TimestampMS;
  let frame: TelemetryFrameView | undefined;
  const target: ResolvedValue<unknown>[] = [];

  for (let packetIndex = 0; packetIndex < packets.length; packetIndex += 1) {
    const packet = packets[packetIndex]!;
    const fraction = distanceFraction(packet, minimumDistance, distanceSpan);
    frame = resolver.createFrameView(
      packet,
      {
        timestamp: { domain: "session", milliseconds: packet.TimestampMS },
        updateSequence: BigInt(packetIndex + 1),
      },
      frame,
    );
    const resolvedValues = frame.resolveMany(slots, target);
    for (let channelIndex = 0; channelIndex < accumulators.length; channelIndex += 1) {
      const semanticId = QUALITY_CHANNEL_IDS[channelIndex]!;
      const accumulator = accumulators[channelIndex]!;
      if (participant.kind === "opponent" && OPPONENT_PLAYER_ONLY_CHANNELS[semanticId] === true) {
        accumulator.summary.mappingStatus = "unavailable";
        accumulator.summary.resolutionCounts["not-applicable"] += 1;
        continue;
      }
      observeChannel(accumulator, resolvedValues[channelIndex]!, packet, lapStartMs, lapEndMs, fraction);
    }
  }

  for (const accumulator of accumulators) {
    closeActiveIssue(accumulator);
    const summary = accumulator.summary;
    const opponentUnavailable = participant.kind === "opponent" && OPPONENT_PLAYER_ONLY_CHANNELS[summary.semanticId] === true;
    summary.expectedCadenceMs = inferredIntervalMs;
    const observationDeltas: number[] = [];
    for (let index = 1; index < accumulator.observationTimes.length; index += 1) {
      const delta = accumulator.observationTimes[index]! - accumulator.observationTimes[index - 1]!;
      if (delta > 0) observationDeltas.push(delta);
    }
    summary.observedCadenceMs = median(observationDeltas);
    summary.coverage = opponentUnavailable || summary.expectedCount === 0 ? null : summary.observedCount / summary.expectedCount;
    summary.confidenceMean = accumulator.confidenceCount === 0 ? null : accumulator.confidenceSum / accumulator.confidenceCount;
    summary.boundaryCoverage.first500Ms = opponentUnavailable || accumulator.firstWindowCount === 0 ? null : accumulator.firstWindowOk / accumulator.firstWindowCount;
    summary.boundaryCoverage.last500Ms = opponentUnavailable || accumulator.lastWindowCount === 0 ? null : accumulator.lastWindowOk / accumulator.lastWindowCount;
    applySourceChannelProfile(summary, sourceChannelProfile);
  }
  return accumulators.map(({ summary }) => summary);
}

function fact(
  provenance: QualityProvenance,
  index: number,
  code: QualityReasonCode,
  options: {
    timeRange?: QualityTimeRange | null;
    distanceRange?: QualityDistanceRange | null;
    semanticIds?: TelemetryVariableId[];
    channelFamilies?: TelemetryGroupId[];
    eventIds?: readonly string[];
    details?: Readonly<Record<string, string | number | boolean | null>>;
  } = {},
): QualityFact {
  return {
    id: `quality-v${QUALITY_SCHEMA_VERSION}:${code}:${index}`,
    code,
    severity: QUALITY_REASON_META[code].defaultSeverity,
    timeRange: options.timeRange ?? null,
    distanceRange: options.distanceRange ?? null,
    semanticIds: options.semanticIds ?? [],
    channelFamilies: options.channelFamilies ?? [],
    provenance,
    eventIds: [...(options.eventIds ?? [])],
    details: options.details,
  };
}

function trackCoverage(packets: readonly TelemetryPacket[]): number | null {
  if (packets.length === 0) return null;
  const distances = packets.map((packet) => packet.DistanceTraveled).filter(Number.isFinite);
  if (distances.length < 2) return null;
  const minimum = Math.min(...distances);
  const maximum = Math.max(...distances);
  const span = maximum - minimum;
  if (span < 100) return clamp01(span / 100);

  const sdkFractions = packets.map((packet) => packet.iracing?.lapDistancePct).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (sdkFractions.length > 1) {
    return clamp01(Math.max(...sdkFractions) - Math.min(...sdkFractions));
  }
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum));
  return scale > 0 ? clamp01(span / scale) : null;
}

function positionCoverage(packets: readonly TelemetryPacket[]): number | null {
  if (packets.length === 0) return null;
  let observed = 0;
  for (const packet of packets) {
    if (Number.isFinite(packet.PositionX) && Number.isFinite(packet.PositionZ) && (packet.PositionX !== 0 || packet.PositionZ !== 0)) observed += 1;
  }
  return observed / packets.length;
}

function damageValue(packet: TelemetryPacket): number {
  const f1 = packet.f1;
  const kunos = packet.acc?.carDamage;
  return (
    (f1?.frontLeftWingDamage ?? 0) +
    (f1?.frontRightWingDamage ?? 0) +
    (f1?.rearWingDamage ?? 0) +
    (f1?.floorDamage ?? 0) +
    (f1?.diffuserDamage ?? 0) +
    (f1?.sidepodDamage ?? 0) +
    (kunos?.front ?? 0) +
    (kunos?.rear ?? 0) +
    (kunos?.left ?? 0) +
    (kunos?.right ?? 0) +
    (kunos?.centre ?? 0)
  );
}

export function summarizeLapQuality(input: {
  packets: readonly TelemetryPacket[];
  lapTime: number;
  timingSource: "simulator-last-lap" | "simulator-history" | "telemetry-elapsed" | "estimated";
  complete: boolean;
  structurallyValid: boolean;
  invalidReason: string | null;
  classification: LapClassification;
  sourceKind: EvidenceSourceKind;
  participant: ParticipantEvidence;
  versionIdentity: TelemetryVersionIdentity;
  sourceChannelProfile?: SourceChannelProfile;
  eventIds?: readonly string[];
}): LapQualitySummary {
  const provenance = baseProvenance(input.sourceKind, input.participant, input.versionIdentity);
  const timeline = measureTimeline(input.packets);
  const sourceChannelProfile = input.sourceChannelProfile?.sourceKind === input.sourceKind ? input.sourceChannelProfile : undefined;
  const channels = measureChannels(input.packets, input.participant, timeline.inferredIntervalMs, timeline.summary.expectedCount, sourceChannelProfile);
  const facts: QualityFact[] = [];
  const pushFact = (code: QualityReasonCode, options?: Parameters<typeof fact>[3]) => {
    facts.push(fact(provenance, facts.length + 1, code, options));
  };
  const totalMissingFraction = timeline.summary.totalMissingFraction ?? 0;
  for (const gap of timeline.gaps) {
    const minor = gap.durationMs <= QUALITY_THRESHOLDS_V1.minorGapMaxMs && totalMissingFraction <= QUALITY_THRESHOLDS_V1.minorMissingFractionMax;
    pushFact(minor ? "telemetry_gap_minor" : "telemetry_gap_major", {
      timeRange: gap.timeRange,
      distanceRange: gap.distanceRange,
      eventIds: input.eventIds,
      details: {
        durationMs: gap.durationMs,
        inferredMissingCount: gap.missingCount,
        countMethod: gap.method,
        sequenceFamily: gap.family,
      },
    });
  }
  if (timeline.duplicateCount > 0) {
    pushFact("duplicate_observations", { details: { count: timeline.duplicateCount } });
  }
  for (const evidence of timeline.outOfOrder) {
    pushFact("out_of_order_observations", { ...evidence, details: { count: 1 } });
  }
  for (const evidence of timeline.discontinuities) {
    pushFact("timeline_discontinuity", { ...evidence, details: { count: 1 } });
  }

  const coverage = trackCoverage(input.packets);
  const positions = positionCoverage(input.packets);
  if (coverage == null || coverage < QUALITY_THRESHOLDS_V1.lapComparisonCoverage) {
    pushFact("partial_track_coverage", { details: { coverage } });
  }
  if (positions == null || positions === 0) pushFact("position_unavailable");

  for (const channel of channels) {
    const common = {
      semanticIds: [channel.semanticId],
      channelFamilies: [channel.channelFamily],
      eventIds: sourceChannelProfile?.channels[channel.semanticId]?.evidenceId ? [sourceChannelProfile.channels[channel.semanticId]!.evidenceId] : [],
    };
    if (input.participant.kind === "opponent" && OPPONENT_PLAYER_ONLY_CHANNELS[channel.semanticId] === true) {
      pushFact("opponent_channel_unavailable", common);
      continue;
    }
    if (channel.mappingStatus === "unavailable") pushFact("channel_unavailable", common);
    else if (channel.mappingStatus === "simplified") pushFact("channel_simplified", common);
    else if (channel.mappingStatus === "derived") pushFact("channel_derived", common);
    if (channel.resolutionCounts.missing > 0) pushFact("channel_missing", common);
    if (channel.resolutionCounts.stale > 0 || channel.freshnessCounts.stale > 0) pushFact("channel_stale", common);
    if (channel.resolutionCounts.invalid > 0 || channel.resolutionCounts.error > 0) pushFact("channel_invalid", common);
    if (channel.limitations.some((limitation) => /pit[- ]?(only|snapshot)/i.test(limitation))) pushFact("pit_only_updates", common);
    if (channel.limitations.some((limitation) => /interpolat/i.test(limitation))) pushFact("interpolated_channel", common);
    if (channel.limitations.some((limitation) => /fallback/i.test(limitation))) pushFact("fallback_channel", common);
  }

  const peakTelemetryLapTime = input.packets.reduce((peak, packet) => (Number.isFinite(packet.CurrentLap) ? Math.max(peak, packet.CurrentLap) : peak), -Infinity);
  const peakTelemetryLapTimeMs = peakTelemetryLapTime > 0 ? peakTelemetryLapTime * 1_000 : null;
  const lapTimeMs = input.lapTime * 1_000;
  const credibleSource = input.timingSource === "simulator-last-lap" || input.timingSource === "simulator-history";
  const timingMatches = peakTelemetryLapTimeMs == null || Math.abs(peakTelemetryLapTimeMs - lapTimeMs) <= 2_000;
  const timingConfirmed = credibleSource && timingMatches;
  if (input.timingSource === "telemetry-elapsed") pushFact("lap_time_fallback");
  if (!timingConfirmed && input.timingSource !== "telemetry-elapsed") pushFact("lap_time_unconfirmed");
  if (!input.complete) pushFact("partial_lap");
  if (!input.structurallyValid) {
    pushFact("structurally_invalid", { details: { invalidReason: input.invalidReason } });
  }
  if (input.classification.paceEligibility !== "eligible") pushFact("non_pace_classification");
  if (input.classification.conditions.length > 0) pushFact("caution_context");
  if (input.sourceKind !== "native-live") pushFact("imported_source");
  if (input.sourceKind === "remote-collector" && timeline.summary.countMethod === "native-sequence") {
    for (const gap of timeline.gaps) {
      pushFact("remote_packet_loss", {
        timeRange: gap.timeRange,
        distanceRange: gap.distanceRange,
        eventIds: input.eventIds,
        details: {
          count: gap.missingCount,
          countMethod: gap.method,
          sequenceFamily: gap.family,
        },
      });
    }
  }
  const firstPacket = input.packets[0];
  const lastPacket = input.packets[input.packets.length - 1];
  if (firstPacket && lastPacket && ((lastPacket.iracing?.incidents ?? 0) > (firstPacket.iracing?.incidents ?? 0) || damageValue(lastPacket) > damageValue(firstPacket))) {
    pushFact("incident_lap", { eventIds: input.eventIds });
  }

  let lifecycleState: RecordingLifecycleState = "exact";
  if (!input.complete) lifecycleState = "incomplete";
  else if (input.packets.length === 0) lifecycleState = "unavailable";
  else if (
    facts.some(({ code }) => code === "telemetry_gap_major" || code === "timeline_discontinuity" || code === "out_of_order_observations") ||
    totalMissingFraction > QUALITY_THRESHOLDS_V1.degradedMissingFraction
  )
    lifecycleState = "degraded";
  else if (facts.some(({ code }) => code === "telemetry_gap_minor")) lifecycleState = "minor_gaps";

  return {
    lifecycleState,
    complete: input.complete,
    structurallyValid: input.structurallyValid,
    invalidReason: input.invalidReason,
    timing: {
      source: input.timingSource,
      lapTimeMs,
      peakTelemetryLapTimeMs,
      confirmed: timingConfirmed,
    },
    timeRange:
      firstPacket && lastPacket
        ? {
            startMs: Math.min(firstPacket.TimestampMS, lastPacket.TimestampMS),
            endMs: Math.max(firstPacket.TimestampMS, lastPacket.TimestampMS),
          }
        : null,
    gapSummary: timeline.summary,
    trackDistanceCoverage: coverage,
    worldPositionCoverage: positions,
    channelQuality: channels,
    facts,
    sourceKind: input.sourceKind,
    participant: input.participant,
    classification: input.classification,
    thresholds: { ...QUALITY_THRESHOLDS_V1 },
    versionIdentity: input.versionIdentity,
    provenance,
  };
}

interface IncrementalSequenceState {
  last: number;
  lastTimestampMs: number;
  positiveStepCounts: Map<number, number>;
  positiveStepCount: number;
  positiveStepMaximumDurationMs: Map<number, number>;
}

function weightedMedian(counts: ReadonlyMap<number, number>, count: number, fallback: number): number {
  const lowerIndex = Math.floor((count - 1) / 2);
  const upperIndex = Math.floor(count / 2);
  let seen = 0;
  let lower = fallback;
  let upper = fallback;
  for (const [value, occurrences] of [...counts].sort(([left], [right]) => left - right)) {
    const end = seen + occurrences;
    if (seen <= lowerIndex && lowerIndex < end) lower = value;
    if (seen <= upperIndex && upperIndex < end) {
      upper = value;
      break;
    }
    seen = end;
  }
  return (lower + upper) / 2;
}

function incrementalSequenceMedian(state: IncrementalSequenceState): number {
  return weightedMedian(state.positiveStepCounts, state.positiveStepCount, 1);
}

export class RecordingQualityAccumulator {
  private readonly sourceKind: EvidenceSourceKind;
  private readonly participant: ParticipantEvidence;
  private readonly versionIdentity: TelemetryVersionIdentity;
  private readonly provenance: QualityProvenance;
  private readonly facts: QualityFact[] = [];
  private readonly pendingFacts: QualityFact[] = [];
  private readonly sequence = new Map<string, IncrementalSequenceState>();
  private readonly positiveTimestampDeltaCounts = new Map<number, number>();
  private positiveTimestampDeltaCount = 0;
  private packetCount = 0;
  private duplicateCount = 0;
  private lastTimestampMs: number | null = null;
  private startTimestampMs: number | null = null;
  private endTimestampMs: number | null = null;

  constructor(sourceKind: EvidenceSourceKind, participant: ParticipantEvidence, versionIdentity: TelemetryVersionIdentity) {
    this.sourceKind = sourceKind;
    this.participant = participant;
    this.versionIdentity = versionIdentity;
    this.provenance = baseProvenance(sourceKind, participant, versionIdentity);
  }

  private recordOutOfOrder(startMs: number, endMs: number): void {
    this.facts.push(
      fact(this.provenance, this.facts.length + 1, "out_of_order_observations", {
        timeRange: { startMs: Math.min(startMs, endMs), endMs: Math.max(startMs, endMs) },
        details: { count: 1 },
      }),
    );
  }

  observe(packet: TelemetryPacket): void {
    for (const pendingFact of this.pendingFacts) {
      if (pendingFact.timeRange) {
        pendingFact.timeRange.endMs = Math.max(pendingFact.timeRange.startMs, packet.TimestampMS);
      }
    }
    this.pendingFacts.length = 0;
    this.packetCount += 1;
    this.startTimestampMs ??= packet.TimestampMS;
    const observations = packetSequences(packet);
    if (this.lastTimestampMs != null) {
      const delta = packet.TimestampMS - this.lastTimestampMs;
      if (delta > 0) {
        this.positiveTimestampDeltaCounts.set(delta, (this.positiveTimestampDeltaCounts.get(delta) ?? 0) + 1);
        this.positiveTimestampDeltaCount += 1;
      } else if (observations.length === 0) {
        if (delta === 0) this.duplicateCount += 1;
        else this.recordOutOfOrder(this.lastTimestampMs, packet.TimestampMS);
      }
    }
    this.lastTimestampMs = packet.TimestampMS;
    this.endTimestampMs = packet.TimestampMS;

    for (const observation of observations) {
      const previous = this.sequence.get(observation.family);
      if (previous) {
        const delta = observation.sequence - previous.last;
        if (delta === 0) this.duplicateCount += 1;
        else if (delta < 0) this.recordOutOfOrder(previous.lastTimestampMs, packet.TimestampMS);
        else {
          previous.positiveStepCounts.set(delta, (previous.positiveStepCounts.get(delta) ?? 0) + 1);
          previous.positiveStepCount += 1;
          previous.positiveStepMaximumDurationMs.set(
            delta,
            Math.max(previous.positiveStepMaximumDurationMs.get(delta) ?? 0, Math.max(0, packet.TimestampMS - previous.lastTimestampMs)),
          );
          previous.last = observation.sequence;
          previous.lastTimestampMs = packet.TimestampMS;
        }
      } else {
        this.sequence.set(observation.family, {
          last: observation.sequence,
          lastTimestampMs: packet.TimestampMS,
          positiveStepCounts: new Map(),
          positiveStepCount: 0,
          positiveStepMaximumDurationMs: new Map(),
        });
      }
    }
  }

  noteSourceLifecycle(event: SourceLifecycleEvidence): void {
    if (event.kind !== "reconnect" && event.kind !== "timeout") return;
    const code: QualityReasonCode = event.kind === "reconnect" ? "source_reconnect" : "timeline_discontinuity";
    const timestampMs = this.lastTimestampMs;
    const lifecycleFact = fact(this.provenance, this.facts.length + 1, code, {
      timeRange: timestampMs == null ? null : { startMs: timestampMs, endMs: timestampMs },
      eventIds: event.eventId ? [event.eventId] : [],
      details: { lifecycleEvent: event.kind, details: event.details ?? null },
    });
    this.facts.push(lifecycleFact);
    if (timestampMs != null) this.pendingFacts.push(lifecycleFact);
  }

  noteWriterFailure(error: unknown): void {
    const timestampMs = this.lastTimestampMs;
    const writerFact = fact(this.provenance, this.facts.length + 1, "writer_drop", {
      timeRange: timestampMs == null ? null : { startMs: timestampMs, endMs: timestampMs },
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    this.facts.push(writerFact);
    if (timestampMs != null) this.pendingFacts.push(writerFact);
  }

  finalize(endReason: string, archiveVerification: ArchiveVerification): RecordingQualitySummary {
    const archiveReason =
      archiveVerification.state === "corrupt"
        ? "recording_corrupt"
        : archiveVerification.state === "truncated"
          ? "recording_incomplete"
          : archiveVerification.state === "unavailable"
            ? "recording_unavailable"
            : archiveVerification.state === "unknown"
              ? "provenance_missing"
              : null;
    if (archiveReason) {
      this.facts.push(
        fact(this.provenance, this.facts.length + 1, archiveReason, {
          timeRange:
            archiveVerification.state === "truncated" && this.endTimestampMs != null
              ? { startMs: this.endTimestampMs, endMs: this.endTimestampMs }
              : null,
          details: { archiveState: archiveVerification.state },
        }),
      );
    }
    if (this.duplicateCount > 0) {
      this.facts.push(
        fact(this.provenance, this.facts.length + 1, "duplicate_observations", {
          details: { count: this.duplicateCount },
        }),
      );
    }
    let missingCount = 0;
    let largestGapMs = 0;
    let countMethod: GapSummary["countMethod"] = "unavailable";
    if (this.sequence.size > 0) {
      countMethod = "native-sequence";
      for (const state of this.sequence.values()) {
        if (state.positiveStepCount === 0) continue;
        const expectedStep = incrementalSequenceMedian(state);
        for (const [step, count] of state.positiveStepCounts) {
          const inferredMissing = Math.max(0, Math.round(step / expectedStep) - 1);
          missingCount += inferredMissing * count;
          if (inferredMissing > 0) {
            largestGapMs = Math.max(largestGapMs, state.positiveStepMaximumDurationMs.get(step) ?? 0);
          }
        }
      }
    } else if (this.positiveTimestampDeltaCount > 0) {
      countMethod = "timestamp-estimate";
      const expectedIntervalMs = weightedMedian(this.positiveTimestampDeltaCounts, this.positiveTimestampDeltaCount, 1);
      for (const [delta, count] of this.positiveTimestampDeltaCounts) {
        const inferredMissing = Math.max(0, Math.round(delta / expectedIntervalMs) - 1);
        missingCount += inferredMissing * count;
        if (inferredMissing > 0) largestGapMs = Math.max(largestGapMs, delta);
      }
    }
    const expectedCount = this.packetCount + missingCount;
    const measuredCount = countMethod !== "unavailable";
    const gapSummary: GapSummary = {
      expectedCount,
      observedCount: this.packetCount,
      totalMissingCount: measuredCount ? missingCount : null,
      totalMissingFraction: measuredCount && expectedCount > 0 ? missingCount / expectedCount : null,
      largestContiguousGapMs: largestGapMs,
      countMethod,
    };
    let lifecycleState: RecordingLifecycleState = "exact";
    if (archiveVerification.state === "unavailable") {
      lifecycleState = "unavailable";
    } else if (archiveVerification.state === "corrupt") lifecycleState = "corrupt";
    else if (archiveVerification.state === "truncated") lifecycleState = "incomplete";
    else if (this.facts.some(({ code }) => code === "writer_drop" || code === "timeline_discontinuity" || code === "source_reconnect" || code === "out_of_order_observations"))
      lifecycleState = "degraded";
    else if ((gapSummary.totalMissingFraction ?? 0) > QUALITY_THRESHOLDS_V1.minorMissingFractionMax) lifecycleState = "degraded";
    else if ((gapSummary.totalMissingCount ?? 0) > 0) lifecycleState = "minor_gaps";

    return {
      lifecycleState,
      gapSummary,
      facts: [...this.facts],
      sourceKind: this.sourceKind,
      participant: this.participant,
      startTimestampMs: this.startTimestampMs,
      endTimestampMs: this.endTimestampMs,
      endReason,
      archiveVerification,
      thresholds: { ...QUALITY_THRESHOLDS_V1 },
      versionIdentity: this.versionIdentity,
      provenance: archiveVerification.sourceGeneration ? { ...this.provenance, sourceGeneration: archiveVerification.sourceGeneration } : this.provenance,
    };
  }
}
