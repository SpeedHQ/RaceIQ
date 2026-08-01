import { expect } from "bun:test";
import { TELEMETRY_CATALOG, type TelemetryLinkKind } from "../../shared/telemetry-catalog";
import type { ResolvedValue, TelemetryFrameView } from "../../shared/telemetry-resolver";
import { compileTelemetryResolver, TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../shared/telemetry-resolver";
import type { GameId } from "../../shared/types";
import { parseDump } from "./parse-dump";

export interface RecordedSemanticExpectation {
  readonly semanticId: string;
  readonly mappingStatus: Exclude<TelemetryLinkKind, "unavailable">;
  readonly unit: string | null;
  readonly accepts: (value: unknown) => boolean;
}

export interface RecordedCatalogCoverage {
  readonly gameId: GameId;
  readonly recording: string;
  readonly expectations: readonly RecordedSemanticExpectation[];
}

/**
 * Exercise one committed native recording through its production parser and
 * pipeline, then resolve canonical semantic values from the emitted packets.
 */
export async function assertRecordedCatalogCoverage(coverage: RecordedCatalogCoverage): Promise<ReadonlyMap<string, ResolvedValue<unknown>>> {
  const parsed = await parseDump(coverage.gameId, coverage.recording);
  if (parsed.rawPackets.length === 0) {
    throw new Error(`${coverage.gameId} recording produced no packets: ${coverage.recording}`);
  }

  expect(parsed.rawPackets.every((packet) => packet.gameId === coverage.gameId)).toBe(true);

  const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
    simulator: coverage.gameId,
    requested: coverage.expectations.map(({ semanticId }) => ({
      semanticId,
      required: true,
    })),
  });
  expect(resolver.catalogVersion).toBe(TELEMETRY_CATALOG.metadata.catalogVersion);
  expect(resolver.catalogHash).toBe(TELEMETRY_CATALOG.metadata.contentHash);
  expect(resolver.schemaVersion).toBe(TELEMETRY_CATALOG.metadata.schemaVersion);
  expect(resolver.parserVersion).toBe(TELEMETRY_PARSER_VERSIONS[coverage.gameId]);
  expect(resolver.resolverVersion).toBe(TELEMETRY_RESOLVER_VERSION);

  const slots = new Map(coverage.expectations.map((expectation) => [expectation.semanticId, resolver.slot(expectation.semanticId)]));
  const resolvedById = new Map<string, ResolvedValue<unknown>>();
  const lastStateById = new Map<string, string>();
  let frame: TelemetryFrameView | undefined;

  for (const packet of parsed.rawPackets) {
    frame = resolver.createFrameView(packet, packet.TimestampMS, frame);
    for (const expectation of coverage.expectations) {
      if (resolvedById.has(expectation.semanticId)) continue;
      const resolved = frame.resolveValue<unknown>(slots.get(expectation.semanticId)!);
      lastStateById.set(expectation.semanticId, resolved.state);
      if (resolved.state !== "ok" || !expectation.accepts(resolved.value)) {
        continue;
      }

      expect(resolved.mappingStatus).toBe(expectation.mappingStatus);
      expect(resolved.unit).toBe(expectation.unit);
      expect(resolved.schemaVersion).toBe(TELEMETRY_CATALOG.metadata.schemaVersion);
      expect(resolved.confidence).toBeGreaterThan(0);
      expect(resolved.provenance.simulator).toBe(coverage.gameId);
      expect(resolved.provenance.parserVersion).toBe(TELEMETRY_PARSER_VERSIONS[coverage.gameId]);
      expect(resolved.provenance.resolverVersion).toBe(TELEMETRY_RESOLVER_VERSION);
      expect(resolved.provenance.catalogHash).toBe(TELEMETRY_CATALOG.metadata.contentHash);
      resolvedById.set(expectation.semanticId, resolved);
    }
    if (resolvedById.size === coverage.expectations.length) break;
  }

  const missing = coverage.expectations.filter(({ semanticId }) => !resolvedById.has(semanticId)).map(({ semanticId }) => `${semanticId} (${lastStateById.get(semanticId) ?? "not-evaluated"})`);
  if (missing.length > 0) {
    throw new Error(`${coverage.gameId} recording did not resolve required semantics: ${missing.join(", ")}`);
  }

  return resolvedById;
}
