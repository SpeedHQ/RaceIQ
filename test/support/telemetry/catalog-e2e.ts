import { expect } from "bun:test";
import type { GameId } from "../../../shared/games/ids";
import type { TelemetryLinkKind } from "../../../shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "../../../shared/telemetry/resolver/compile";
import type { ResolvedValue, TelemetryFrameView } from "../../../shared/telemetry/resolver/contracts";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../../shared/telemetry/resolver/versions";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { parseDump, segmentTelemetryLaps, type TelemetryLapSegment } from "../recordings/parse-dump";

// Catalog assertions need representative lap dynamics, not every broadcast
// frame. parseDump preserves each lap/session boundary plus this deterministic
// reservoir sample of its interior.
const CATALOG_PACKETS_PER_SEGMENT = 512;

export interface RecordedSemanticExpectation {
  readonly semanticId: string;
  readonly mappingStatus: Exclude<TelemetryLinkKind, "unavailable">;
  readonly unit: string | null;
  readonly accepts: (value: unknown) => boolean;
  /** Minimum accepted numeric range across the recording. Omit for static/event-driven semantics. */
  readonly minimumRange?: number;
}

export interface RecordedLapDynamicsExpectation {
  readonly name: string;
  readonly read: (packet: TelemetryPacket) => number | undefined;
  readonly minimumRange?: number;
}

export function changingPacketFields(fields: readonly (keyof TelemetryPacket)[]): RecordedLapDynamicsExpectation[] {
  return fields.map((field) => ({
    name: String(field),
    read: (packet) => {
      const value = packet[field];
      return typeof value === "number" ? value : undefined;
    },
  }));
}

export interface RecordedCatalogCoverage {
  readonly gameId: GameId;
  readonly recording: string;
  readonly expectations: readonly RecordedSemanticExpectation[];
  /** Semantic bindings advertised by adapter; continuous values must resolve to finite numbers. */
  readonly requiredSemanticIds?: readonly string[];
  /** Continuous values displayed by UI that must vary within one representative lap. */
  readonly lapDynamics?: readonly RecordedLapDynamicsExpectation[];
}

interface PacketRange {
  min: number;
  max: number;
}

interface SampledRange extends PacketRange {
  count: number;
}

interface LapCandidate extends TelemetryLapSegment {
  rawFailureCount: number;
}

interface LapDynamicsMeasurement {
  readonly ranges: ReadonlyMap<string, PacketRange>;
  readonly finiteCounts: ReadonlyMap<string, number>;
}

function measureLapDynamics(packets: readonly TelemetryPacket[], expectations: readonly RecordedLapDynamicsExpectation[], start = 0, end = packets.length): LapDynamicsMeasurement {
  const ranges = new Map<string, PacketRange>();
  const finiteCounts = new Map<string, number>();
  for (let index = start; index < end; index += 1) {
    const packet = packets[index];
    for (const expectation of expectations) {
      const value = expectation.read(packet);
      if (value === undefined || !Number.isFinite(value)) continue;
      finiteCounts.set(expectation.name, (finiteCounts.get(expectation.name) ?? 0) + 1);
      const range = ranges.get(expectation.name);
      if (range) {
        range.min = Math.min(range.min, value);
        range.max = Math.max(range.max, value);
      } else {
        ranges.set(expectation.name, { min: value, max: value });
      }
    }
  }
  return { ranges, finiteCounts };
}

function failedLapDynamics(measurement: LapDynamicsMeasurement, expectations: readonly RecordedLapDynamicsExpectation[]): readonly RecordedLapDynamicsExpectation[] {
  return expectations.filter((expectation) => {
    const range = measurement.ranges.get(expectation.name);
    return (measurement.finiteCounts.get(expectation.name) ?? 0) < 2 || range === undefined || range.max - range.min <= (expectation.minimumRange ?? 0);
  });
}

function candidateLapSegments(packets: readonly TelemetryPacket[], expectations: readonly RecordedLapDynamicsExpectation[]): LapCandidate[] {
  return segmentTelemetryLaps(packets)
    .filter((segment) => segment.end - segment.start >= 30 && segment.minLapTime < 1 && segment.maxLapTime - segment.minLapTime > 10)
    .map((segment) => ({
      ...segment,
      rawFailureCount: failedLapDynamics(measureLapDynamics(packets, expectations, segment.start, segment.end), expectations).length,
    }))
    .sort((left, right) => left.start - right.start);
}

function assertLapDynamics(gameId: GameId, packets: readonly TelemetryPacket[], segment: TelemetryLapSegment, expectations: readonly RecordedLapDynamicsExpectation[]): void {
  if (expectations.length === 0) return;
  const measurement = measureLapDynamics(packets, expectations, segment.start, segment.end);
  const failures = failedLapDynamics(measurement, expectations).map((expectation) => {
    const range = measurement.ranges.get(expectation.name);
    return `${expectation.name} (range ${range ? range.max - range.min : 0}, required > ${expectation.minimumRange ?? 0})`;
  });
  if (failures.length > 0) {
    throw new Error(`${gameId} displayed telemetry stayed constant within one lap: ${failures.join(", ")}`);
  }
}

/**
 * Exercise one committed native recording through its production parser and
 * pipeline, then resolve canonical semantic values from the emitted packets.
 */
export async function assertRecordedCatalogCoverage(coverage: RecordedCatalogCoverage): Promise<ReadonlyMap<string, ResolvedValue<unknown>>> {
  const parsed = await parseDump(coverage.gameId, coverage.recording, {
    packetSampling: {
      maxPacketsPerSegment: CATALOG_PACKETS_PER_SEGMENT,
      validatePacket: (packet) => {
        if (packet.gameId !== coverage.gameId) {
          throw new Error(`${coverage.gameId} parser emitted a ${packet.gameId} packet`);
        }
      },
    },
  });
  if (parsed.rawPackets.length === 0) {
    throw new Error(`${coverage.gameId} recording produced no packets: ${coverage.recording}`);
  }

  const oversizedSegment = segmentTelemetryLaps(parsed.rawPackets)
    .find((segment) => segment.end - segment.start > CATALOG_PACKETS_PER_SEGMENT);
  if (oversizedSegment) {
    throw new Error(
      `${coverage.gameId} retained ${oversizedSegment.end - oversizedSegment.start} packets for one segment; ` +
      `catalog replay is capped at ${CATALOG_PACKETS_PER_SEGMENT}`,
    );
  }

  expect(parsed.rawPackets.every((packet) => packet.gameId === coverage.gameId)).toBe(true);
  const explicitById = new Map(coverage.expectations.map((expectation) => [expectation.semanticId, expectation]));
  const requiredExpectations: RecordedSemanticExpectation[] = (coverage.requiredSemanticIds ?? [])
    .filter((semanticId) => !explicitById.has(semanticId))
    .flatMap((semanticId) => {
      const variable = TELEMETRY_CATALOG.variables.find((candidate) => candidate.id === semanticId);
      if (!variable) throw new Error(`${coverage.gameId} required semantic ${semanticId} is unknown`);
      const mapping = variable.games[coverage.gameId];
      if (!mapping || mapping.kind === "unavailable") {
        throw new Error(`${coverage.gameId} required semantic ${semanticId} is unavailable`);
      }
      return [{
        semanticId,
        mappingStatus: mapping.kind,
        accepts: (value: unknown) => {
          const acceptsValue = (item: unknown): boolean =>
            variable.valueType === "number" ? typeof item === "number" && Number.isFinite(item) :
            variable.valueType === "boolean" ? typeof item === "boolean" :
            variable.valueType === "string" ? typeof item === "string" :
            typeof item === "string" || (typeof item === "number" && Number.isFinite(item));
          return Array.isArray(value) ? value.length > 0 && value.every(acceptsValue) : acceptsValue(value);
        },
        unit: variable.canonicalUnit,
      }];
    });
  const expectations = [...coverage.expectations, ...requiredExpectations];
  const lapDynamics = coverage.lapDynamics ?? [];
  const needsRepresentativeLap = lapDynamics.length > 0 || expectations.some((expectation) => expectation.minimumRange !== undefined);
  const lapCandidates = needsRepresentativeLap ? candidateLapSegments(parsed.rawPackets, lapDynamics) : [];
  if (needsRepresentativeLap && lapCandidates.length === 0) {
    throw new Error("Recording has no complete representative lap with progressing CurrentLap");
  }

  const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
    simulator: coverage.gameId,
    requested: expectations.map(({ semanticId }) => ({
      semanticId,
      required: true,
    })),
  });
  expect(resolver.catalogVersion).toBe(TELEMETRY_CATALOG.metadata.catalogVersion);
  expect(resolver.catalogHash).toBe(TELEMETRY_CATALOG.metadata.contentHash);
  expect(resolver.schemaVersion).toBe(TELEMETRY_CATALOG.metadata.schemaVersion);
  expect(resolver.parserVersion).toBe(TELEMETRY_PARSER_VERSIONS[coverage.gameId]);
  expect(resolver.resolverVersion).toBe(TELEMETRY_RESOLVER_VERSION);

  const slots = new Map(expectations.map((expectation) => [expectation.semanticId, resolver.slot(expectation.semanticId)]));
  const resolvedById = new Map<string, ResolvedValue<unknown>>();
  const lastStateById = new Map<string, string>();
  const rangesByLapStart = new Map<number, Map<string, SampledRange>>(lapCandidates.map((candidate) => [candidate.start, new Map()]));
  let frame: TelemetryFrameView | undefined;
  let candidateCursor = 0;


  for (let packetIndex = 0; packetIndex < parsed.rawPackets.length; packetIndex += 1) {
    while (candidateCursor < lapCandidates.length && lapCandidates[candidateCursor].end <= packetIndex) {
      candidateCursor += 1;
    }
    const possibleCandidate = lapCandidates[candidateCursor];
    const currentCandidate = possibleCandidate && packetIndex >= possibleCandidate.start && packetIndex < possibleCandidate.end ? possibleCandidate : undefined;
    const packet = parsed.rawPackets[packetIndex];
    frame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, frame);

    for (const expectation of expectations) {
      const requiredRange = expectation.minimumRange;
      if (resolvedById.has(expectation.semanticId) && (requiredRange === undefined || currentCandidate === undefined)) {
        continue;
      }
      const resolved = frame.resolveValue<unknown>(slots.get(expectation.semanticId)!);
      lastStateById.set(expectation.semanticId, resolved.state);
      if (resolved.state !== "ok" || !expectation.accepts(resolved.value)) {
        continue;
      }

      if (!resolvedById.has(expectation.semanticId)) {
        expect(resolved.mappingStatus).toBe(expectation.mappingStatus);
        expect(resolved.schemaVersion).toBe(TELEMETRY_CATALOG.metadata.schemaVersion);
        expect(resolved.confidence).toBeGreaterThan(0);
        expect(resolved.provenance.simulator).toBe(coverage.gameId);
        expect(resolved.provenance.parserVersion).toBe(TELEMETRY_PARSER_VERSIONS[coverage.gameId]);
        expect(resolved.provenance.resolverVersion).toBe(TELEMETRY_RESOLVER_VERSION);
        expect(resolved.provenance.catalogHash).toBe(TELEMETRY_CATALOG.metadata.contentHash);
        resolvedById.set(expectation.semanticId, resolved);
      }

      if (requiredRange !== undefined && currentCandidate) {
        if (typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) {
          throw new TypeError(`${coverage.gameId} dynamic semantic ${expectation.semanticId} did not resolve to a finite number`);
        }
        const ranges = rangesByLapStart.get(currentCandidate.start)!;
        const prior = ranges.get(expectation.semanticId);
        if (prior) {
          prior.min = Math.min(prior.min, resolved.value);
          prior.max = Math.max(prior.max, resolved.value);
          prior.count += 1;
        } else {
          ranges.set(expectation.semanticId, {
            min: resolved.value,
            max: resolved.value,
            count: 1,
          });
        }
      }
    }
  }
  const missing = expectations.filter(({ semanticId }) => !resolvedById.has(semanticId)).map(({ semanticId }) => `${semanticId} (${lastStateById.get(semanticId) ?? "not-evaluated"})`);
  if (missing.length > 0) {
    throw new Error(`${coverage.gameId} recording did not resolve required semantics: ${missing.join(", ")}`);
  }

  const rankedCandidates = lapCandidates
    .map((candidate) => {
      const semanticFailureCount = expectations.filter((expectation) => {
        if (expectation.minimumRange === undefined) return false;
        const ranges = rangesByLapStart.get(candidate.start)!;
        const range = ranges.get(expectation.semanticId);
        return range === undefined || range.count < 2 || range.max - range.min <= expectation.minimumRange;
      }).length;
      return { ...candidate, semanticFailureCount };
    })
    .sort(
      (left, right) =>
        left.rawFailureCount + left.semanticFailureCount - (right.rawFailureCount + right.semanticFailureCount) ||
        left.rawFailureCount - right.rawFailureCount ||
        right.end - right.start - (left.end - left.start),
    );
  const representativeLap = rankedCandidates[0];
  if (representativeLap) {
    assertLapDynamics(coverage.gameId, parsed.rawPackets, representativeLap, lapDynamics);
  }

  const representativeRanges = representativeLap ? rangesByLapStart.get(representativeLap.start)! : new Map<string, SampledRange>();
  const staticDynamics = expectations
    .filter((expectation) => {
      if (expectation.minimumRange === undefined) return false;
      const range = representativeRanges.get(expectation.semanticId);
      return range === undefined || range.count < 2 || range.max - range.min <= expectation.minimumRange;
    })
    .map((expectation) => {
      const range = representativeRanges.get(expectation.semanticId);
      const actual = range ? range.max - range.min : 0;
      return `${expectation.semanticId} (range ${actual}, required > ${expectation.minimumRange})`;
    });
  if (staticDynamics.length > 0) {
    throw new Error(`${coverage.gameId} recording held dynamic semantics constant within one lap: ${staticDynamics.join(", ")}`);
  }

  return resolvedById;
}
