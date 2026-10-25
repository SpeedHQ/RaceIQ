import { LMU_MAX_VEHICLES } from "@raceiq/capture-formats/lmu/layout";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LmuOpponentSessionSummary, LmuOpponentSummaryFacts } from "./lmu-opponent-summary";

export const LMU_OPPONENT_INDEX_SCHEMA_VERSION = 1;
export const LMU_OPPONENT_INDEX_ALGORITHM_VERSION = 3;
export const LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES = 256;
export const LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES = 16 * 1024 * 1024;
export const LMU_OPPONENT_INDEX_MAX_METADATA_BYTES = 16 * 1024 * 1024;
export const LMU_OPPONENT_INDEX_MAX_BLOCKS = 100_000;
export const LMU_OPPONENT_INDEX_MAX_INTERVALS = 100_000;
export const LMU_OPPONENT_INDEX_MAX_PLAYER_LAPS = 100_000;
export const LMU_OPPONENT_INDEX_MAX_LOCATOR_SEGMENTS = 1_000_000;
export const LMU_OPPONENT_INDEX_MAX_CHANNELS = 256;

export interface LmuOpponentIndexSourceDependency {
  role: string;
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface LmuOpponentPlayerLapFacts {
  playerLapId: number;
  comparableChannelIds: readonly string[];
}

export interface LmuOpponentIndexBlockDescriptor {
  id: number;
  file: string;
  kind: "context" | "competitor";
  identityHash?: string;
  byteLength: number;
  sha256: string;
  firstFrame: number;
  lastFrame: number;
  firstSequence: string;
  lastSequence: string;
}

export interface LmuOpponentIntervalRepeat {
  frameIndex: number;
  extraCount: number;
}

export interface LmuOpponentIntervalLocator {
  blockIndex: number;
  firstFrameIndex: number;
  lastFrameIndex: number;
  repeatedFrames: readonly LmuOpponentIntervalRepeat[];
}

export interface LmuOpponentIndexInterval extends LmuOpponentSummaryFacts {
  startSequence: string;
  endSequence: string | null;
  locators: readonly LmuOpponentIntervalLocator[];
}

export interface LmuOpponentIndexManifest {
  schemaVersion: number;
  algorithmVersion: number;
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  playerLapFacts: readonly LmuOpponentPlayerLapFacts[];
  summaries: readonly LmuOpponentSummaryFacts[];
  sessions: readonly LmuOpponentSessionSummary[];
  intervals: readonly LmuOpponentIndexInterval[];
  blocks: readonly LmuOpponentIndexBlockDescriptor[];
}

const decimal = /^(0|[1-9][0-9]{0,39})$/;
const nonNegativeInteger = z.number().int().safe().nonnegative();
const timestampSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("monotonic"), nanoseconds: z.string().regex(decimal) }).strict(),
  z.object({ domain: z.literal("session"), milliseconds: z.number().finite().nonnegative() }).strict(),
  z.object({ domain: z.literal("wall-clock"), milliseconds: z.number().finite().nonnegative() }).strict(),
]);
const resolvedNumberWireSchema = z.object({
  semanticId: z.string().min(1).max(256),
  value: z.number().finite().nullable(),
  unit: z.string().nullable(),
  mappingStatus: z.enum(["direct", "normalized", "derived", "simplified", "unavailable"]),
  state: z.enum(["ok", "missing", "stale", "invalid", "not-applicable", "error"]),
  confidence: z.number().finite().nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  confidenceComponents: z.object({
    semanticFidelity: z.number().finite().min(0).max(1),
    freshness: z.number().finite().min(0).max(1).nullable(),
    inputCompleteness: z.number().finite().min(0).max(1),
    derivationReliability: z.number().finite().min(0).max(1).optional(),
  }).strict(),
  provenance: z.object({
    simulator: z.string().min(1), parserId: z.string().min(1), parserVersion: z.string().min(1),
    resolverVersion: z.string().min(1), catalogVersion: z.string().min(1), catalogHash: z.string().min(1),
    sourceChannel: z.string().optional(), sourceUnit: z.string().optional(),
    observedAt: timestampSchema,
    sourceObservation: z.object({ timestamp: timestampSchema, updateSequence: z.string().regex(decimal) }).strict().optional(),
    derivation: z.object({ id: z.string(), version: z.string(), codeHash: z.string() }).strict().optional(),
  }).passthrough(),
  schemaVersion: z.string().min(1),
  limitations: z.array(z.string()).max(32),
}).passthrough();
const summaryFactsSchema = z.object({
  opponentLapId: z.string().regex(/^[0-9a-f]{64}$/),
  sessionKey: z.string().min(1).max(2048),
  vehicleId: nonNegativeInteger,
  incarnation: nonNegativeInteger,
  driverName: z.string().nullable(),
  carName: z.string().nullable(),
  className: z.string().nullable(),
  lapNumber: z.number().finite().nullable(),
  coverage: z.enum(["complete", "partial"]),
  validity: z.enum(["valid", "invalid", "unknown"]),
  lapTime: resolvedNumberWireSchema,
  sectors: z.array(z.object({ semanticId: z.string().min(1).max(256), duration: resolvedNumberWireSchema }).strict()).max(8),
  opponentNumericChannelIds: z.array(z.string().min(1).max(256)).max(LMU_OPPONENT_INDEX_MAX_CHANNELS),
}).strict();
const dependencySchema = z.object({
  role: z.string().min(1).max(64), path: z.string().min(1).max(4096),
  dev: z.string().max(128), ino: z.string().max(128), size: nonNegativeInteger,
  mtimeMs: z.number().finite(), ctimeMs: z.number().finite(),
}).strict();
const blockSchema = z.object({
  id: nonNegativeInteger,
  file: z.string().regex(/^blocks\/[0-9]{8}\.bin$/),
  kind: z.enum(["context", "competitor"]),
  identityHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  byteLength: z.number().int().positive().max(LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  firstFrame: nonNegativeInteger,
  lastFrame: nonNegativeInteger,
  firstSequence: z.string().regex(decimal),
  lastSequence: z.string().regex(decimal),
}).strict().refine((value) => value.lastFrame >= value.firstFrame &&
  value.lastFrame - value.firstFrame < LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES &&
  ((value.kind === "competitor") === (value.identityHash !== undefined)));
const playerFactsSchema = z.object({
  playerLapId: z.number().int().safe().positive(),
  comparableChannelIds: z.array(z.string().min(1).max(256)).max(LMU_OPPONENT_INDEX_MAX_CHANNELS),
}).strict();
const repeatSchema = z.object({
  frameIndex: nonNegativeInteger,
  extraCount: z.number().int().safe().positive().max(LMU_MAX_VEHICLES - 1),
}).strict();
const locatorSchema = z.object({
  blockIndex: nonNegativeInteger,
  firstFrameIndex: nonNegativeInteger,
  lastFrameIndex: nonNegativeInteger,
  repeatedFrames: z.array(repeatSchema).max(256),
}).strict().refine((value) => value.lastFrameIndex >= value.firstFrameIndex &&
  value.lastFrameIndex - value.firstFrameIndex < LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES);
const intervalSchema = summaryFactsSchema.extend({
  startSequence: z.string().regex(decimal),
  endSequence: z.string().regex(decimal).nullable(),
  locators: z.array(locatorSchema).max(LMU_OPPONENT_INDEX_MAX_BLOCKS),
}).strict();
const sessionSchema = z.object({
  opponentSessionId: z.string().regex(/^[0-9a-f]{64}$/),
  sessionKey: z.string().min(1).max(2048),
  vehicleId: nonNegativeInteger,
  incarnation: nonNegativeInteger,
  driverName: z.string().nullable(),
  carName: z.string().nullable(),
  className: z.string().nullable(),
  lapIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(LMU_OPPONENT_INDEX_MAX_INTERVALS),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(LMU_OPPONENT_INDEX_SCHEMA_VERSION),
  algorithmVersion: z.literal(LMU_OPPONENT_INDEX_ALGORITHM_VERSION),
  sourceRevision: z.string().min(1).max(512),
  sourceDependencies: z.array(dependencySchema).max(4096),
  playerLapFacts: z.array(playerFactsSchema).max(LMU_OPPONENT_INDEX_MAX_PLAYER_LAPS),
  summaries: z.array(summaryFactsSchema).max(LMU_OPPONENT_INDEX_MAX_INTERVALS),
  sessions: z.array(sessionSchema).max(LMU_OPPONENT_INDEX_MAX_INTERVALS),
  intervals: z.array(intervalSchema).max(LMU_OPPONENT_INDEX_MAX_INTERVALS),
  blocks: z.array(blockSchema).max(LMU_OPPONENT_INDEX_MAX_BLOCKS),
}).strict().superRefine((manifest, context) => {
  const playerLapIds = new Set<number>();
  for (const facts of manifest.playerLapFacts) {
    if (playerLapIds.has(facts.playerLapId)) context.addIssue({ code: "custom", path: ["playerLapFacts"], message: "Duplicate player lap facts" });
    playerLapIds.add(facts.playerLapId);
    if (new Set(facts.comparableChannelIds).size !== facts.comparableChannelIds.length) {
      context.addIssue({ code: "custom", path: ["playerLapFacts"], message: "Duplicate comparable channel fact" });
    }
  }
  if (manifest.summaries.length !== manifest.intervals.length ||
      manifest.summaries.some((summary, index) => summary.opponentLapId !== manifest.intervals[index]?.opponentLapId)) {
    context.addIssue({ code: "custom", path: ["summaries"], message: "Summary and interval identity order mismatch" });
  }
  let locatorCount = 0;
  for (const interval of manifest.intervals) {
    const blockIndexes = new Set<number>();
    const identityHash = createHash("sha256")
      .update(JSON.stringify([interval.sessionKey, interval.vehicleId, interval.incarnation])).digest("hex");
    for (const locator of interval.locators) {
      locatorCount += 1;
      const block = manifest.blocks[locator.blockIndex];
      if (!block) context.addIssue({ code: "custom", path: ["intervals"], message: "Interval locator references absent block" });
      else if (block.kind !== "competitor" || block.identityHash !== identityHash) {
        context.addIssue({ code: "custom", path: ["intervals"], message: "Interval locator references a different competitor stream" });
      }
      if (blockIndexes.has(locator.blockIndex)) context.addIssue({ code: "custom", path: ["intervals"], message: "Interval contains duplicate block locator" });
      blockIndexes.add(locator.blockIndex);
      if (locator.lastFrameIndex >= LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES) {
        context.addIssue({ code: "custom", path: ["intervals"], message: "Block-local frame locator exceeds frame cap" });
      }
      for (const repeat of locator.repeatedFrames) {
        if (repeat.frameIndex < locator.firstFrameIndex || repeat.frameIndex > locator.lastFrameIndex) {
          context.addIssue({ code: "custom", path: ["intervals"], message: "Repeated frame lies outside locator range" });
        }
      }
    }
  }
  if (locatorCount > LMU_OPPONENT_INDEX_MAX_LOCATOR_SEGMENTS) {
    context.addIssue({ code: "custom", path: ["intervals"], message: "Index locator segment limit exceeded" });
  }
  for (const [index, block] of manifest.blocks.entries()) {
    if (block.id !== index) context.addIssue({ code: "custom", path: ["blocks", index, "id"], message: "Block IDs must be ordered and contiguous" });
    if (block.file !== `blocks/${String(index).padStart(8, "0")}.bin`) {
      context.addIssue({ code: "custom", path: ["blocks", index, "file"], message: "Block path does not match ID" });
    }
  }
});

export function parseLmuOpponentIndexManifest(value: unknown): LmuOpponentIndexManifest {
  return manifestSchema.parse(value) as LmuOpponentIndexManifest;
}
