import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LmuCompetitor, LmuLiveContext } from "@raceiq/shared/telemetry/lmu";
import { decodeLmuContext, encodeLmuContext, type LmuCompetitorWire, type LmuLiveContextWire } from "@raceiq/shared/telemetry/lmu-context";
import type { TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";
import type { PublishedManifest } from "@raceiq/capture-splitting";
import { MAX_CAPTURE_MANIFEST_BYTES } from "@raceiq/capture-splitting";
import type { SessionCaptureSource } from "../session-capture/source-loader";
import { loadCaptureManifest } from "../session-capture/source-loader";
import { isUnmanifestedLegacyNativeSource, readLmuOpponentRetention } from "../session-capture/lmu-companion";
import {
  LmuOpponentAdmissionError,
  LmuOpponentIndexLimitError,
  LmuOpponentLapIndexer,
  LmuOpponentSourceError,
  iterateLmuOpponentCaptureFrames,
  type LmuOpponentFrame,
  type LmuOpponentFrameLocator,
  type LmuOpponentLapIndexRecord,
  type LmuOpponentLapInterval,
} from "./lmu-opponent-laps";
import {
  createLmuOpponentSummaryFacts,
  groupLmuOpponentSessions,
  sortLmuOpponentSummaryFacts,
  summarizeLmuOpponentSummaryFacts,
  type LmuOpponentSessionSummary,
  type LmuOpponentSummaryFacts,
  type LmuOpponentLapSummary,
} from "./lmu-opponent-summary";
import {
  LMU_OPPONENT_INDEX_ALGORITHM_VERSION,
  LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES,
  LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES,
  LMU_OPPONENT_INDEX_MAX_BLOCKS,
  LMU_OPPONENT_INDEX_MAX_INTERVALS,
  LMU_OPPONENT_INDEX_MAX_LOCATOR_SEGMENTS,
  LMU_OPPONENT_INDEX_MAX_METADATA_BYTES,
  LMU_OPPONENT_INDEX_SCHEMA_VERSION,
  parseLmuOpponentIndexManifest,
  type LmuOpponentIndexBlockDescriptor,
  type LmuOpponentIndexInterval,
  type LmuOpponentIndexManifest,
  type LmuOpponentIndexSourceDependency,
  type LmuOpponentPlayerLapFacts,
} from "./lmu-opponent-index-schema";
export type {
  LmuOpponentIndexBlockDescriptor,
  LmuOpponentIndexInterval,
  LmuOpponentIndexManifest,
  LmuOpponentIndexSourceDependency,
  LmuOpponentPlayerLapFacts,
} from "./lmu-opponent-index-schema";


const BLOCK_HEADER_BYTES = 24;
const BLOCK_LAST_PART = 1;
const INDEX_FILE_NAME = "index.json";
const STAGING_PREFIX = ".staging-";
const PUBLICATION_PREFIX = "publication-";
const INVALIDATED_PREFIX = ".invalidated-";

export type LmuOpponentIndexErrorCode =
  | "INDEX_NOT_FOUND"
  | "INDEX_INCOMPATIBLE"
  | "INDEX_CORRUPT"
  | "SOURCE_CHANGED"
  | "SOURCE_UNAVAILABLE"
  | "BLOCK_CORRUPT"
  | "PLAYER_FACTS_NOT_FOUND";

export class LmuOpponentIndexError extends Error {
  readonly code: LmuOpponentIndexErrorCode;
  constructor(code: LmuOpponentIndexErrorCode, message: string) {
    super(message);
    this.name = "LmuOpponentIndexError";
    this.code = code;
  }
}

export interface LmuOpponentIndexStagedPublication {
  stagingDirectory: string;
  publicationDirectory: string;
  /** Staging manifest path; caller renames stagingDirectory atomically before switching reference. */
  manifestPath: string;
  /** Final immutable path expected after caller renames stagingDirectory. */
  publicationPath: string;
  manifest: LmuOpponentIndexManifest;
}

export type LmuOpponentIndexAdmission = () => Promise<boolean>;
export type LmuOpponentIndexPublish = (staged: LmuOpponentIndexStagedPublication) => Promise<boolean>;

export interface BuildLmuOpponentIndexOptions {
  source: SessionCaptureSource;
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
  playerLapFacts: readonly LmuOpponentPlayerLapFacts[];
  /** Lifecycle-owned `<sourcePath>.opponent-index/` root. */
  indexRoot: string;
  admission: LmuOpponentIndexAdmission;
  publish: LmuOpponentIndexPublish;
}

export interface LmuOpponentIndexBuildStats {
  sourceFramesScanned: number;
  observations: number;
  competitorRecords: number;
  blocksWritten: number;
  bytesWritten: number;
}

export interface LmuOpponentIndexBuildResult {
  published: boolean;
  publicationPath: string | null;
  manifest: LmuOpponentIndexManifest | null;
  stats: LmuOpponentIndexBuildStats;
}

export interface LmuOpponentIndex {
  publicationPath: string;
  manifest: LmuOpponentIndexManifest;
}

export interface LmuOpponentIntervalReadStats {
  blocksRead: number;
  bytesRead: number;
  framesDecoded: number;
}

export type LmuOpponentLoadedInterval = LmuOpponentLapInterval & { stats: LmuOpponentIntervalReadStats };

export interface LmuOpponentIndexArtifact {
  path: string;
  kind: "state" | "publication" | "staging" | "invalidated" | "other";
  bytes: number;
}

export interface LmuOpponentIndexInventory {
  rootPath: string;
  artifacts: readonly LmuOpponentIndexArtifact[];
  totalBytes: number;
}

interface ContextRecord {
  kind: "context";
  frameIndex: number;
  sessionKey: string;
  captureSequence: string;
  frameTime: number;
  lmuContext?: LmuLiveContextWire;
}

interface CompetitorRecord {
  kind: "competitor";
  frameIndex: number;
  competitorIndex: number;
  competitor: LmuCompetitorWire;
}

interface RecordPart {
  frameIndex: number;
  recordId: number;
  partIndex: number;
  isLast: boolean;
  payload: Buffer;
}

interface MutableBlock {
  id: number;
  file: string;
  handle: Awaited<ReturnType<typeof open>>;
  hash: ReturnType<typeof createHash>;
  byteLength: number;
  firstFrame: number;
  lastFrame: number;
  firstSequence: string;
  lastSequence: string;
  localFrameIndexes: Map<number, number>;
}

interface BlockWriterOptions {
  directory: string;
  kind: "context" | "competitor";
  identityHash?: string;
  allocateId: () => number;
  onBlockClosed: () => Promise<void>;
  stats: LmuOpponentIndexBuildStats;
  descriptors: Map<number, LmuOpponentIndexBlockDescriptor>;
  recordIdState?: { value: number };
}

function identityKey(sessionKey: string, vehicleId: number, incarnation: number): string {
  return JSON.stringify([sessionKey, vehicleId, incarnation]);
}

function identityHash(sessionKey: string, vehicleId: number, incarnation: number): string {
  return createHash("sha256").update(JSON.stringify([sessionKey, vehicleId, incarnation])).digest("hex");
}

async function readBoundedFile(filePath: string, maxBytes: number, expectedLength?: number): Promise<Buffer> {
  const limit = expectedLength ?? maxBytes;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maxBytes) {
    throw new RangeError("Opponent index file exceeds size limit");
  }
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new RangeError("Opponent index file exceeds size limit");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  return (async () => {
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
      if (bytesWritten <= 0) throw new Error("Index block write made no progress");
      offset += bytesWritten;
    }
  })();
}

function jsonBytes(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Opponent index record is not JSON serializable");
  return Buffer.from(json, "utf8");
}

function encodeCompetitor(competitor: LmuCompetitor, frame: LmuOpponentFrame): LmuCompetitorWire {
  const context = frame.lmuContext;
  const frameTime: TelemetryTimestamp = context?.key.frameTime ?? { domain: "wall-clock", milliseconds: frame.frameTime };
  const wire = encodeLmuContext({
    schemaVersion: 1,
    key: { sessionKey: frame.sessionKey, captureSequence: frame.captureSequence, frameTime },
    playerVehicleId: competitor.isPlayer ? competitor.vehicleId : null,
    status: context?.status ?? "active",
    supplemental: [],
    competitors: [competitor],
  });
  const encoded = wire.competitors?.[0];
  if (!encoded) throw new TypeError("LMU competitor codec omitted competitor");
  return encoded;
}

function encodeContextBase(context: LmuLiveContext | undefined): LmuLiveContextWire | undefined {
  if (!context) return undefined;
  return encodeLmuContext({
    ...context,
    ...(context.competitors === undefined ? {} : {
      competitors: context.competitors.map((competitor) => ({ ...competitor, channels: {} })),
    }),
  });
}

class BlockStreamWriter {
  private current: MutableBlock | null = null;
  private readonly recordIdState: { value: number };
  private readonly options: BlockWriterOptions;

  constructor(options: BlockWriterOptions) {
    this.options = options;
    this.recordIdState = options.recordIdState ?? { value: 0 };
  }

  async writeRecord(frameIndex: number, sequence: string, value: unknown): Promise<LmuOpponentFrameLocator> {
    const payload = jsonBytes(value);
    if (!payload.length) throw new Error("Opponent index record encoded empty");
    if (this.recordIdState.value > 0xffff_ffff) throw new Error("Opponent index stream record count exceeds framing limit");
    const recordId = this.recordIdState.value++;
    await this.ensureFrame(frameIndex, sequence);
    const firstLocator = { blockIndex: this.current!.id, frameIndex: this.current!.localFrameIndexes.get(frameIndex)! };
    let offset = 0;
    let partIndex = 0;
    while (offset < payload.length) {
      if (!this.current || this.current.byteLength + BLOCK_HEADER_BYTES >= LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES) {
        await this.flush();
        await this.ensureFrame(frameIndex, sequence);
      }
      const block = this.current!;
      const available = LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES - block.byteLength - BLOCK_HEADER_BYTES;
      const partLength = Math.min(available, payload.length - offset);
      if (partLength <= 0) throw new Error("Opponent index block has no payload capacity");
      const isLast = offset + partLength === payload.length;
      const header = Buffer.allocUnsafe(BLOCK_HEADER_BYTES);
      header.writeBigUInt64LE(BigInt(frameIndex), 0);
      header.writeUInt32LE(recordId, 8);
      header.writeUInt32LE(partIndex++, 12);
      header.writeUInt32LE(partLength, 16);
      header.writeUInt32LE(isLast ? BLOCK_LAST_PART : 0, 20);
      await writeAll(block.handle, header);
      const part = payload.subarray(offset, offset + partLength);
      await writeAll(block.handle, part);
      block.hash.update(header).update(part);
      block.byteLength += header.length + part.length;
      block.firstFrame = Math.min(block.firstFrame, frameIndex);
      block.lastFrame = Math.max(block.lastFrame, frameIndex);
      block.lastSequence = sequence;
      this.options.stats.bytesWritten += header.length + part.length;
      offset += partLength;
      if (offset < payload.length) await this.flush();
    }
    return firstLocator;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  async abort(): Promise<void> {
    if (!this.current) return;
    const current = this.current;
    this.current = null;
    await current.handle.close().catch(() => undefined);
  }

  private async ensureFrame(frameIndex: number, sequence: string): Promise<void> {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error("Opponent index frame ordinal is outside safe integer range");
    if (this.current && (frameIndex < this.current.lastFrame ||
        frameIndex - this.current.firstFrame >= LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES ||
        this.current.byteLength + BLOCK_HEADER_BYTES >= LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES)) {
      await this.flush();
    }
    if (!this.current) {
      const id = this.options.allocateId();
      const file = `blocks/${String(id).padStart(8, "0")}.bin`;
      const handle = await open(join(this.options.directory, file), "wx");
      this.current = {
        id, file, handle, hash: createHash("sha256"), byteLength: 0,
        firstFrame: frameIndex, lastFrame: frameIndex, firstSequence: sequence, lastSequence: sequence,
        localFrameIndexes: new Map(),
      };
    }
    const block = this.current;
    if (!block.localFrameIndexes.has(frameIndex)) block.localFrameIndexes.set(frameIndex, block.localFrameIndexes.size);
    block.lastFrame = frameIndex;
    block.lastSequence = sequence;
  }

  private async flush(): Promise<void> {
    if (!this.current) return;
    const block = this.current;
    this.current = null;
    try {
      await block.handle.sync();
    } finally {
      await block.handle.close();
    }
    const descriptor: LmuOpponentIndexBlockDescriptor = {
      id: block.id,
      file: block.file,
      kind: this.options.kind,
      ...(this.options.identityHash ? { identityHash: this.options.identityHash } : {}),
      byteLength: block.byteLength,
      sha256: block.hash.digest("hex"),
      firstFrame: block.firstFrame,
      lastFrame: block.lastFrame,
      firstSequence: block.firstSequence,
      lastSequence: block.lastSequence,
    };
    this.options.descriptors.set(block.id, descriptor);
    this.options.stats.blocksWritten++;
    await this.options.onBlockClosed();
  }
}

function sameDependencies(
  left: readonly LmuOpponentIndexSourceDependency[],
  right: readonly LmuOpponentIndexSourceDependency[],
): boolean {
  const normalize = (dependencies: readonly LmuOpponentIndexSourceDependency[]) => [...dependencies]
    .sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path))
    .map(({ role, path, dev, ino, size, mtimeMs, ctimeMs }) => [role, path, dev, ino, size, mtimeMs, ctimeMs]);
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function fileDependency(role: string, filePath: string): Promise<LmuOpponentIndexSourceDependency> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(resolve(filePath));
  } catch {
    throw new LmuOpponentIndexError("SOURCE_CHANGED", `Opponent source dependency is unavailable: ${filePath}`);
  }
  const info = await stat(resolvedPath).catch(() => null);
  if (!info?.isFile()) throw new LmuOpponentIndexError("SOURCE_CHANGED", `Opponent source dependency is not a file: ${filePath}`);
  return {
    role,
    path: resolvedPath,
    dev: String(info.dev),
    ino: String(info.ino),
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function assertManifestRelativePath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new LmuOpponentIndexError("INDEX_CORRUPT", "Capture manifest contains an absolute or empty dependency path");
  const resolved = resolve(root, relativePath);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", "Capture manifest dependency escapes its directory");
  }
  return resolved;
}

export async function describeLmuOpponentSource(source: SessionCaptureSource): Promise<{
  sourceRevision: string;
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[];
}> {
  if (source.gameId !== "lmu" || source.artifact) {
    throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index requires a whole-session LMU source manifest");
  }
  const dependencies: LmuOpponentIndexSourceDependency[] = [];
  const manifestPath = source.rawFile.endsWith("manifest.json") ? resolve(source.rawFile) : null;
  if (!manifestPath) {
    const sourceDependency = await fileDependency("source", source.rawFile);
    return {
      sourceRevision: `${sourceDependency.dev}:${sourceDependency.ino}:${sourceDependency.size}:${sourceDependency.mtimeMs}`,
      sourceDependencies: [sourceDependency],
    };
  }
  const manifestInfo = await stat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.size > MAX_CAPTURE_MANIFEST_BYTES) {
    throw new LmuOpponentIndexError("SOURCE_CHANGED", "Capture manifest is unavailable or exceeds its size limit");
  }
  let manifest: PublishedManifest;
  try {
    manifest = await loadCaptureManifest(manifestPath);
  } catch (error) {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", error instanceof Error ? error.message : "Capture manifest is invalid");
  }
  const manifestDependency = await fileDependency("manifest", manifestPath);
  dependencies.push(manifestDependency);
  const directory = await realpath(dirname(manifestPath));
  if (manifest.version === 3) {
    for (const chunk of manifest.chunks) {
      const chunkPath = assertManifestRelativePath(directory, chunk.path);
      const resolved = await realpath(chunkPath).catch(() => {
        throw new LmuOpponentIndexError("SOURCE_CHANGED", `Capture chunk is unavailable: ${chunk.id}`);
      });
      const rel = relative(directory, resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new LmuOpponentIndexError("INDEX_CORRUPT", `Capture chunk escapes manifest directory: ${chunk.id}`);
      }
      dependencies.push(await fileDependency(`chunk:${chunk.id}`, resolved));
    }
    if (manifest.opponentCompanion) {
      const companionPath = assertManifestRelativePath(directory, manifest.opponentCompanion.file);
      const resolved = await realpath(companionPath).catch(() => {
        throw new LmuOpponentIndexError("SOURCE_CHANGED", "LMU opponent companion is unavailable");
      });
      const rel = relative(directory, resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new LmuOpponentIndexError("INDEX_CORRUPT", "LMU opponent companion escapes manifest directory");
      }
      dependencies.push(await fileDependency("opponent-companion", resolved));
    }
  } else {
    const archivePath = assertManifestRelativePath(directory, manifest.archiveFile);
    const resolved = await realpath(archivePath).catch(() => {
      throw new LmuOpponentIndexError("SOURCE_CHANGED", "Capture archive is unavailable");
    });
    const rel = relative(directory, resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new LmuOpponentIndexError("INDEX_CORRUPT", "Capture archive escapes manifest directory");
    }
    dependencies.push(await fileDependency("archive", resolved));
  }
  dependencies.sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path));
  return { sourceRevision: manifest.sourceRevision, sourceDependencies: dependencies };
}


async function assertCurrentSource(
  source: SessionCaptureSource,
  sourceRevision: string,
  sourceDependencies: readonly LmuOpponentIndexSourceDependency[],
  admission: LmuOpponentIndexAdmission,
): Promise<void> {
  if (!(await admission())) throw new LmuOpponentAdmissionError();
  const current = await describeLmuOpponentSource(source);
  if (current.sourceRevision !== sourceRevision || !sameDependencies(current.sourceDependencies, sourceDependencies)) {
    throw new LmuOpponentIndexError("SOURCE_CHANGED", "Opponent source dependency identities changed");
  }
  const retention = await readLmuOpponentRetention(source.rawFile, { admission }).catch((error) => {
    if (error instanceof LmuOpponentAdmissionError) throw error;
    throw new LmuOpponentIndexError("SOURCE_UNAVAILABLE", error instanceof Error ? error.message : "LMU source validation failed");
  });
  if (retention.sourceRevision !== sourceRevision) {
    throw new LmuOpponentIndexError("SOURCE_CHANGED", "Opponent source revision changed");
  }
  const legacyNativeSource = retention.opponentAvailability === "incomplete" &&
    source.gameId === "lmu" && await isUnmanifestedLegacyNativeSource(source.rawFile);
  if (retention.opponentRetention !== "retained" ||
      (retention.opponentAvailability !== "complete" && !legacyNativeSource)) {
    throw new LmuOpponentIndexError("SOURCE_UNAVAILABLE", "LMU opponent source is not completely retained");
  }
  if (!(await admission())) throw new LmuOpponentAdmissionError();
}

async function tryRemove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

function contextRecord(frame: LmuOpponentFrame, frameIndex: number): ContextRecord {
  return {
    kind: "context",
    frameIndex,
    sessionKey: frame.sessionKey,
    captureSequence: frame.captureSequence,
    frameTime: frame.frameTime,
    ...(frame.lmuContext ? { lmuContext: encodeContextBase(frame.lmuContext) } : {}),
  };
}

function factsForRecord(record: LmuOpponentLapIndexRecord): LmuOpponentSummaryFacts {
  return createLmuOpponentSummaryFacts({
    opponentLapId: record.opponentLapId,
    sessionKey: record.sessionKey,
    vehicleId: record.vehicleId,
    incarnation: record.incarnation,
    lapNumber: record.lapNumber,
    coverage: record.coverage,
    validity: record.validity,
    endSequence: record.endSequence,
    lastCompetitor: record.lastCompetitor,
    opponentNumericChannelIds: record.opponentNumericChannelIds,
  });
}

function intervalForRecord(
  record: LmuOpponentLapIndexRecord,
  facts: LmuOpponentSummaryFacts,
): LmuOpponentIndexInterval {
  return {
    ...facts,
    startSequence: record.startSequence,
    endSequence: record.endSequence,
    locators: record.locators,
  };
}

function asErrno(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

export async function buildLmuOpponentIndex(options: BuildLmuOpponentIndexOptions): Promise<LmuOpponentIndexBuildResult> {
  const stats: LmuOpponentIndexBuildStats = {
    sourceFramesScanned: 0,
    observations: 0,
    competitorRecords: 0,
    blocksWritten: 0,
    bytesWritten: 0,
  };
  const root = resolve(options.indexRoot);
  const publicationId = randomUUID();
  const stagingDirectory = join(root, `${STAGING_PREFIX}${publicationId}`);
  const publicationDirectory = join(root, `${PUBLICATION_PREFIX}${publicationId}`);
  const manifestPath = join(stagingDirectory, INDEX_FILE_NAME);
  const publicationPath = join(publicationDirectory, INDEX_FILE_NAME);
  const streamWriters = new Map<string, BlockStreamWriter>();
  const identityRecordIds = new Map<string, { value: number }>();
  let contextWriter: BlockStreamWriter | null = null;
  let published = false;
  const completedBlocks = new Map<number, LmuOpponentIndexBlockDescriptor>();
  const checkAdmission = async () => {
    if (!(await options.admission())) throw new LmuOpponentAdmissionError();
  };
  let nextBlockId = 0;
  const allocateId = () => {
    if (nextBlockId >= LMU_OPPONENT_INDEX_MAX_BLOCKS) {
      throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index block limit exceeded");
    }
    return nextBlockId++;
  };
  const onBlockClosed = checkAdmission;
  const indexer = new LmuOpponentLapIndexer(LMU_OPPONENT_INDEX_MAX_LOCATOR_SEGMENTS);
  const records: LmuOpponentLapIndexRecord[] = [];

  try {
    await assertCurrentSource(options.source, options.sourceRevision, options.sourceDependencies, options.admission);
    await mkdir(join(stagingDirectory, "blocks"), { recursive: true });
    contextWriter = new BlockStreamWriter({
      directory: stagingDirectory,
      kind: "context",
      allocateId,
      onBlockClosed,
      stats,
      descriptors: completedBlocks,
    });
    let frameIndex = 0;
    for await (const frame of iterateLmuOpponentCaptureFrames(options.source, {
      retainSourceFrames: false,
      onSourceFrame: () => { stats.sourceFramesScanned++; },
      admission: options.admission,
    })) {
      if (!Number.isSafeInteger(frameIndex)) throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent source has too many observations");
      const index = frameIndex++;
      stats.observations++;
      await contextWriter.writeRecord(index, frame.captureSequence, contextRecord(frame, index));
      const present = new Set<string>();
      const locatorByIdentity = new Map<string, LmuOpponentFrameLocator>();
      for (const [competitorIndex, competitor] of frame.competitors.entries()) {
        if (competitor.isPlayer) continue;
        const key = identityKey(frame.sessionKey, competitor.vehicleId, competitor.incarnation);
        const digest = identityHash(frame.sessionKey, competitor.vehicleId, competitor.incarnation);
        present.add(key);
        let writer = streamWriters.get(key);
        if (!writer) {
          const recordIdState = identityRecordIds.get(key) ?? { value: 0 };
          identityRecordIds.set(key, recordIdState);
          writer = new BlockStreamWriter({
            directory: stagingDirectory,
            kind: "competitor",
            identityHash: digest,
            allocateId,
            onBlockClosed,
            stats,
            descriptors: completedBlocks,
            recordIdState,
          });
          streamWriters.set(key, writer);
        }
        const competitorWire = await encodeCompetitor(competitor, frame);
        const locator = await writer.writeRecord(index, frame.captureSequence, {
          kind: "competitor", frameIndex: index, competitorIndex, competitor: competitorWire,
        } satisfies CompetitorRecord);
        stats.competitorRecords++;
        if (!locatorByIdentity.has(key)) locatorByIdentity.set(key, locator);
      }
      for (const [key, writer] of streamWriters) {
        if (present.has(key)) continue;
        await writer.close();
        streamWriters.delete(key);
      }
      records.push(...indexer.push(frame, (competitor) => {
        const locator = locatorByIdentity.get(identityKey(frame.sessionKey, competitor.vehicleId, competitor.incarnation));
        if (!locator) throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent interval lacks a competitor block locator");
        return locator;
      }));
      if (records.length > LMU_OPPONENT_INDEX_MAX_INTERVALS) {
        throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index interval limit exceeded");
      }
      if (indexer.locatorSegmentCount > LMU_OPPONENT_INDEX_MAX_LOCATOR_SEGMENTS) {
        throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index locator segment limit exceeded");
      }
    }
    records.push(...indexer.finish());
    if (records.length > LMU_OPPONENT_INDEX_MAX_INTERVALS) {
      throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index interval limit exceeded");
    }
    for (const writer of streamWriters.values()) await writer.close();
    streamWriters.clear();
    await contextWriter.close();
    await checkAdmission();
    await assertCurrentSource(options.source, options.sourceRevision, options.sourceDependencies, options.admission);

    const factIntervals: Array<{ facts: LmuOpponentSummaryFacts; interval: LmuOpponentIndexInterval }> = [];
    for (const [recordIndex, record] of records.entries()) {
      if (recordIndex > 0 && recordIndex % 256 === 0) await checkAdmission();
      const facts = factsForRecord(record);
      factIntervals.push({ facts, interval: intervalForRecord(record, facts) });
    }
    const summaries = sortLmuOpponentSummaryFacts(factIntervals.map(({ facts }) => facts));
    const intervalByFacts = new Map(factIntervals.map(({ facts, interval }) => [facts, interval]));
    const intervals = summaries.map((summary) => intervalByFacts.get(summary)!);
    const allLapSummaries = summaries.map((summary) => summarizeLmuOpponentSummaryFacts(summary, []));
    const sessions = groupLmuOpponentSessions(allLapSummaries);
    const playerLapFacts: LmuOpponentPlayerLapFacts[] = [];
    for (const [factsIndex, facts] of options.playerLapFacts.entries()) {
      if (factsIndex > 0 && factsIndex % 256 === 0) await checkAdmission();
      playerLapFacts.push({
        playerLapId: facts.playerLapId,
        comparableChannelIds: [...new Set(facts.comparableChannelIds)].sort(),
      });
    }
    const manifest = parseLmuOpponentIndexManifest({
      schemaVersion: LMU_OPPONENT_INDEX_SCHEMA_VERSION,
      algorithmVersion: LMU_OPPONENT_INDEX_ALGORITHM_VERSION,
      sourceRevision: options.sourceRevision,
      sourceDependencies: options.sourceDependencies,
      playerLapFacts,
      summaries,
      sessions,
      intervals,
      blocks: [...completedBlocks.values()].sort((a, b) => a.id - b.id),
    });
    const manifestBytes = jsonBytes(manifest);
    if (manifestBytes.byteLength > LMU_OPPONENT_INDEX_MAX_METADATA_BYTES) {
      throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index metadata exceeds 16 MiB limit");
    }
    const manifestHandle = await open(manifestPath, "wx");
    try {
      await writeAll(manifestHandle, manifestBytes);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    await checkAdmission();
    await assertCurrentSource(options.source, options.sourceRevision, options.sourceDependencies, options.admission);
    const staged: LmuOpponentIndexStagedPublication = {
      stagingDirectory,
      publicationDirectory,
      manifestPath,
      publicationPath,
      manifest,
    };
    published = await options.publish(staged);
    if (!published) {
      await tryRemove(stagingDirectory);
      return { published: false, publicationPath: null, manifest: null, stats };
    }
    return { published: true, publicationPath, manifest, stats };
  } catch (error) {
    await contextWriter?.abort();
    for (const writer of streamWriters.values()) await writer.abort();
    await tryRemove(stagingDirectory);
    if (error instanceof LmuOpponentAdmissionError) return { published: false, publicationPath: null, manifest: null, stats };
    if (error instanceof LmuOpponentIndexLimitError) {
      throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", error.message);
    }
    if (error instanceof LmuOpponentIndexError || error instanceof LmuOpponentSourceError) throw error;
    const code = asErrno(error).code;
    if (code === "ENOENT" || code === "EIO" || code === "EACCES") {
      throw new LmuOpponentIndexError("SOURCE_CHANGED", error instanceof Error ? error.message : "Opponent index storage failed");
    }
    throw error;
}
}

async function currentDependencyIdentity(dependency: LmuOpponentIndexSourceDependency): Promise<boolean> {
  try {
    const resolved = await realpath(dependency.path);
    if (resolved !== dependency.path) return false;
    const info = await stat(resolved);
    return info.isFile() && String(info.dev) === dependency.dev && String(info.ino) === dependency.ino &&
      info.size === dependency.size && info.mtimeMs === dependency.mtimeMs && info.ctimeMs === dependency.ctimeMs;
  } catch {
    return false;
  }
}

function stableDependencies(dependencies: readonly LmuOpponentIndexSourceDependency[]): LmuOpponentIndexSourceDependency[] {
  return [...dependencies].sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path));
}

export async function readLmuOpponentIndex(
  publicationPath: string,
  expected: { sourceRevision: string; sourceDependencies: readonly LmuOpponentIndexSourceDependency[] },
): Promise<LmuOpponentIndex> {
  const manifestPath = resolve(publicationPath);
  const publicationDirectory = dirname(manifestPath);
  if (basename(manifestPath) !== INDEX_FILE_NAME || !basename(publicationDirectory).startsWith(PUBLICATION_PREFIX)) {
    throw new LmuOpponentIndexError("INDEX_NOT_FOUND", "Opponent publication path must name a published index.json");
  }
  const publicationInfo = await lstat(publicationDirectory).catch(() => null);
  if (!publicationInfo?.isDirectory() || publicationInfo.isSymbolicLink()) {
    throw new LmuOpponentIndexError("INDEX_NOT_FOUND", "Opponent publication directory is unavailable");
  }
  const info = await lstat(manifestPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new LmuOpponentIndexError("INDEX_NOT_FOUND", "Opponent index manifest is unavailable");
  if (info.size > LMU_OPPONENT_INDEX_MAX_METADATA_BYTES) {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent index metadata exceeds 16 MiB limit");
  }
  let raw: unknown;
  try {
    const bytes = await readBoundedFile(manifestPath, LMU_OPPONENT_INDEX_MAX_METADATA_BYTES, info.size);
    const current = await lstat(manifestPath);
    if (bytes.length !== info.size || current.isSymbolicLink() || current.size !== info.size ||
        current.ino !== info.ino || current.dev !== info.dev || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
      throw new Error("Opponent index manifest changed during read");
    }
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent index manifest is not valid stable JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent index manifest must be an object");
  const versions = raw as { schemaVersion?: unknown; algorithmVersion?: unknown };
  if (versions.schemaVersion !== LMU_OPPONENT_INDEX_SCHEMA_VERSION || versions.algorithmVersion !== LMU_OPPONENT_INDEX_ALGORITHM_VERSION) {
    throw new LmuOpponentIndexError("INDEX_INCOMPATIBLE", "Opponent index schema or algorithm version is incompatible");
  }
  let manifest: LmuOpponentIndexManifest;
  try {
    manifest = parseLmuOpponentIndexManifest(raw);
  } catch {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent index manifest failed schema validation");
  }
  if (manifest.sourceRevision !== expected.sourceRevision ||
      !sameDependencies(manifest.sourceDependencies, expected.sourceDependencies)) {
    throw new LmuOpponentIndexError("SOURCE_CHANGED", "Opponent index source identity does not match current source");
  }
  for (const dependency of stableDependencies(expected.sourceDependencies)) {
    if (!(await currentDependencyIdentity(dependency))) {
      throw new LmuOpponentIndexError("SOURCE_CHANGED", `Opponent source dependency changed: ${dependency.role}`);
    }
  }
  return { publicationPath: manifestPath, manifest };
}

export function readLmuOpponentCatalogSummary(
  index: LmuOpponentIndex,
  playerLapId: number,
): { laps: LmuOpponentLapSummary[]; sessions: LmuOpponentSessionSummary[] } {
  const playerFacts = index.manifest.playerLapFacts.find((facts) => facts.playerLapId === playerLapId);
  if (!playerFacts) throw new LmuOpponentIndexError("PLAYER_FACTS_NOT_FOUND", "Opponent index has no facts for this player lap");
  const laps = sortLmuOpponentSummaryFacts(index.manifest.summaries)
    .map((facts) => summarizeLmuOpponentSummaryFacts(facts, playerFacts.comparableChannelIds));
  return { laps, sessions: groupLmuOpponentSessions(laps) };
}

function parseBlockParts(
  bytes: Buffer,
  descriptor: LmuOpponentIndexBlockDescriptor,
  selectedFrames?: ReadonlySet<number>,
): { frameIndexes: number[]; parts: RecordPart[] } {
  if (bytes.length !== descriptor.byteLength || bytes.length > LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block length mismatch");
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== descriptor.sha256) throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block hash mismatch");
  const frameIndexes = new Set<number>();
  const parts: RecordPart[] = [];
  let offset = 0;
  let minFrame = Number.POSITIVE_INFINITY;
  let maxFrame = -1;
  let previousFrame = -1;
  while (offset < bytes.length) {
    if (offset + BLOCK_HEADER_BYTES > bytes.length) throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block has truncated record header");
    const frameBig = bytes.readBigUInt64LE(offset);
    const frameIndex = Number(frameBig);
    const recordId = bytes.readUInt32LE(offset + 8);
    const partIndex = bytes.readUInt32LE(offset + 12);
    const payloadLength = bytes.readUInt32LE(offset + 16);
    const flags = bytes.readUInt32LE(offset + 20);
    offset += BLOCK_HEADER_BYTES;
    if (!Number.isSafeInteger(frameIndex) || frameIndex < descriptor.firstFrame || frameIndex > descriptor.lastFrame ||
        frameIndex < previousFrame || payloadLength === 0 ||
        payloadLength > LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES - BLOCK_HEADER_BYTES ||
        flags & ~BLOCK_LAST_PART || offset + payloadLength > bytes.length) {
      throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block record header is invalid");
    }
    previousFrame = frameIndex;
    minFrame = Math.min(minFrame, frameIndex);
    maxFrame = Math.max(maxFrame, frameIndex);
    frameIndexes.add(frameIndex);
    if (!selectedFrames || selectedFrames.has(frameIndex)) {
      parts.push({ frameIndex, recordId, partIndex, isLast: (flags & BLOCK_LAST_PART) !== 0, payload: bytes.subarray(offset, offset + payloadLength) });
    }
    offset += payloadLength;
  }
  if (!frameIndexes.size || frameIndexes.size > LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES ||
      maxFrame - minFrame >= LMU_OPPONENT_INDEX_MAX_BLOCK_FRAMES ||
      minFrame !== descriptor.firstFrame || maxFrame !== descriptor.lastFrame) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block exceeds frame-count limit");
  }
  return { frameIndexes: [...frameIndexes].sort((a, b) => a - b), parts };
}

function recordPartsById(parts: readonly RecordPart[]): Map<number, { frameIndex: number; parts: Buffer[] }> {
  const records = new Map<number, { frameIndex: number; parts: Buffer[]; isLast: boolean }>();
  for (const part of parts) {
    const record = records.get(part.recordId) ?? { frameIndex: part.frameIndex, parts: [], isLast: false };
    if (record.frameIndex !== part.frameIndex || record.isLast || part.partIndex !== record.parts.length) {
      throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Record fragments are unordered, duplicated, or disagree on frame identity");
    }
    record.parts.push(part.payload);
    record.isLast = part.isLast;
    records.set(part.recordId, record);
  }
  const ready = new Map<number, { frameIndex: number; parts: Buffer[] }>();
  for (const [recordId, record] of records) {
    if (!record.isLast) throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Selected opponent record has incomplete fragments");
    ready.set(recordId, { frameIndex: record.frameIndex, parts: record.parts });
  }
  return ready;
}

function decodeRecord<T>(parts: readonly Buffer[]): T {
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
  } catch {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index record is not valid JSON");
  }
}

function decodeCompetitorWire(wire: LmuCompetitorWire, frame: ContextRecord): LmuCompetitor {
  const key = frame.lmuContext?.key ?? {
    sessionKey: frame.sessionKey,
    captureSequence: frame.captureSequence,
    frameTime: { domain: "wall-clock" as const, milliseconds: frame.frameTime },
  };
  const context = decodeLmuContext({
    schemaVersion: 1,
    key,
    playerVehicleId: null,
    status: "active",
    supplemental: [],
    competitors: [wire],
  });
  const competitor = context?.competitors?.[0];
  if (!competitor) throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent competitor wire failed lossless codec validation");
  return competitor;
}

async function readSelectedBlock(
  publicationDirectory: string,
  descriptor: LmuOpponentIndexBlockDescriptor,
  selectedFrames?: ReadonlySet<number>,
): Promise<{ bytes: Buffer; parsed: ReturnType<typeof parseBlockParts> }> {
  if (descriptor.byteLength > LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block exceeds size limit");
  }
  const publicationLink = await lstat(publicationDirectory).catch(() => null);
  if (!publicationLink?.isDirectory() || publicationLink.isSymbolicLink()) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent publication directory is unavailable");
  }
  const root = await realpath(publicationDirectory).catch(() => {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent publication directory is unavailable");
  });
  const blocksDirectory = join(root, "blocks");
  const blocksLink = await lstat(blocksDirectory).catch(() => null);
  if (!blocksLink?.isDirectory() || blocksLink.isSymbolicLink()) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent block directory is unavailable");
  }
  const blockPath = resolve(root, descriptor.file);
  const relativePath = relative(root, blockPath);
  if (relativePath !== descriptor.file || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent block path escapes publication directory");
  }
  const link = await lstat(blockPath).catch(() => null);
  if (!link?.isFile() || link.isSymbolicLink() || link.size !== descriptor.byteLength) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block is unavailable");
  }
  const resolved = await realpath(blockPath).catch(() => {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block is unavailable");
  });
  if (resolved !== join(blocksDirectory, basename(descriptor.file))) {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent block resolves outside publication directory");
  }
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(resolved, LMU_OPPONENT_INDEX_MAX_BLOCK_BYTES, descriptor.byteLength);
  } catch {
    throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index block could not be read within size limit");
  }
  return { bytes, parsed: parseBlockParts(bytes, descriptor, selectedFrames) };
}

function localFrameIndexByGlobal(frameIndexes: readonly number[]): Map<number, number> {
  return new Map(frameIndexes.map((frameIndex, localIndex) => [localIndex, frameIndex]));
}

function selectedGlobalFrameOrder(interval: LmuOpponentIndexInterval, blockFrames: ReadonlyMap<number, readonly number[]>): number[] {
  const output: number[] = [];
  for (const locator of interval.locators) {
    const localToGlobal = localFrameIndexByGlobal(blockFrames.get(locator.blockIndex) ?? []);
    const repeated = new Map(locator.repeatedFrames.map((entry) => [entry.frameIndex, entry.extraCount]));
    for (let local = locator.firstFrameIndex; local <= locator.lastFrameIndex; local++) {
      const global = localToGlobal.get(local);
      if (global === undefined) throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Interval locator points outside selected block frames");
      output.push(global);
      for (let extra = repeated.get(local) ?? 0; extra > 0; extra--) output.push(global);
    }
  }
  return output;
}

function framesOverlap(descriptor: LmuOpponentIndexBlockDescriptor, firstFrame: number, lastFrame: number): boolean {
  return descriptor.lastFrame >= firstFrame && descriptor.firstFrame <= lastFrame;
}

function parseSelectedRecords<T>(parts: readonly RecordPart[], expectedKind: "context" | "competitor"): Map<number, T[]> {
  const records = recordPartsById(parts);
  const byFrame = new Map<number, T[]>();
  for (const record of records.values()) {
    const value = decodeRecord<T>(record.parts);
    const typed = value as { kind?: unknown; frameIndex?: unknown };
    if (typed.kind !== expectedKind || typed.frameIndex !== record.frameIndex) {
      throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Opponent index record disagrees with block descriptor");
    }
    if (expectedKind === "context") {
      const contextRecord = value as ContextRecord;
      if (typeof contextRecord.sessionKey !== "string" || typeof contextRecord.captureSequence !== "string" ||
          typeof contextRecord.frameTime !== "number" || !Number.isFinite(contextRecord.frameTime)) {
        throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Shared context record has invalid frame identity");
      }
      if (contextRecord.lmuContext) {
        let context: LmuLiveContext | null;
        try {
          context = decodeLmuContext(contextRecord.lmuContext);
        } catch {
          throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Shared context failed lossless codec validation");
        }
        // Native acquisition keys remain provenance; opponent session grouping has its own identity.
        if (!context || context.key.captureSequence !== contextRecord.captureSequence) {
          throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Shared context key disagrees with frame identity");
        }
      }
    } else {
      const competitorRecord = value as CompetitorRecord;
      if (!Number.isSafeInteger(competitorRecord.competitorIndex) || competitorRecord.competitorIndex < 0 ||
          typeof competitorRecord.competitor !== "object" || competitorRecord.competitor === null) {
        throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Competitor record has invalid source index or wire");
      }
    }
    const values = byFrame.get(record.frameIndex) ?? [];
    if (expectedKind === "context" && values.length) {
      throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Selected interval contains duplicate shared context records");
    }
    values.push(value);
    byFrame.set(record.frameIndex, values);
  }
  return byFrame;
}

export async function loadLmuOpponentInterval(
  index: LmuOpponentIndex,
  opponentLapId: string,
): Promise<LmuOpponentLoadedInterval> {
  const interval = index.manifest.intervals.find((entry) => entry.opponentLapId === opponentLapId);
  if (!interval) throw new LmuOpponentIndexError("INDEX_NOT_FOUND", "Opponent lap is not present in index");
  if (!interval.locators.length) throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent interval has no block locators");
  const targetHash = identityHash(interval.sessionKey, interval.vehicleId, interval.incarnation);
  const blocks = index.manifest.blocks;
  const stats: LmuOpponentIntervalReadStats = { blocksRead: 0, bytesRead: 0, framesDecoded: 0 };
  const locatorFrames = new Map<number, readonly number[]>();
  const loadedBytes = new Map<number, Buffer>();
  for (const locator of interval.locators) {
    if (locatorFrames.has(locator.blockIndex)) continue;
    const descriptor = blocks[locator.blockIndex];
    if (!descriptor || descriptor.kind !== "competitor" || descriptor.identityHash !== targetHash) {
      throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent interval locator references incompatible block");
    }
    const result = await readSelectedBlock(dirname(index.publicationPath), descriptor);
    stats.blocksRead++;
    stats.bytesRead += result.bytes.length;
    locatorFrames.set(descriptor.id, result.parsed.frameIndexes);
    loadedBytes.set(descriptor.id, result.bytes);
  }
  const frameOrder = selectedGlobalFrameOrder(interval, locatorFrames);
  const selectedFrames = new Set(frameOrder);
  if (!selectedFrames.size) throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent interval selects no source observations");
  let firstSelectedFrame = Number.POSITIVE_INFINITY;
  let lastSelectedFrame = -1;
  for (const frameIndex of selectedFrames) {
    firstSelectedFrame = Math.min(firstSelectedFrame, frameIndex);
    lastSelectedFrame = Math.max(lastSelectedFrame, frameIndex);
  }
  const candidateBlocks = blocks.filter((descriptor) =>
    (descriptor.kind === "context" || descriptor.kind === "competitor" && descriptor.identityHash === targetHash) &&
    framesOverlap(descriptor, firstSelectedFrame, lastSelectedFrame));
  const contextParts: RecordPart[] = [];
  const competitorParts: RecordPart[] = [];
  for (const descriptor of candidateBlocks) {
    let bytes = loadedBytes.get(descriptor.id);
    let parsed: ReturnType<typeof parseBlockParts>;
    if (bytes) {
      parsed = parseBlockParts(bytes, descriptor, selectedFrames);
    } else {
      const result = await readSelectedBlock(dirname(index.publicationPath), descriptor, selectedFrames);
      bytes = result.bytes;
      parsed = result.parsed;
      stats.blocksRead++;
      stats.bytesRead += bytes.length;
    }
    if (descriptor.kind === "context") contextParts.push(...parsed.parts);
    else competitorParts.push(...parsed.parts);
  }
  const contextRecords = parseSelectedRecords<ContextRecord>(contextParts, "context");
  const competitorRecords = parseSelectedRecords<CompetitorRecord>(competitorParts, "competitor");
  const baseContexts = new Map<number, ContextRecord>();
  for (const frameIndex of selectedFrames) {
    const record = contextRecords.get(frameIndex)?.[0];
    if (!record) throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Selected interval lacks shared context record");
    if (record.sessionKey !== interval.sessionKey) {
      throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Shared context disagrees with opponent session identity");
    }
    baseContexts.set(frameIndex, record);
  }
  const frames: LmuOpponentFrame[] = frameOrder.map((frameIndex) => {
    const base = baseContexts.get(frameIndex)!;
    const competitorEntries = (competitorRecords.get(frameIndex) ?? [])
      .sort((left, right) => left.competitorIndex - right.competitorIndex);
    const sourceIndexes = new Set<number>();
    for (const entry of competitorEntries) {
      if (sourceIndexes.has(entry.competitorIndex)) {
        throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Competitor stream repeats source array index");
      }
      sourceIndexes.add(entry.competitorIndex);
    }
    const competitors = competitorEntries.map((entry) => decodeCompetitorWire(entry.competitor, base));
    if (competitors.some((competitor) => competitor.isPlayer ||
        competitor.vehicleId !== interval.vehicleId || competitor.incarnation !== interval.incarnation) ||
        !competitors.length) {
      throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Selected interval competitor identity disagrees with its stream");
    }
    let lmuContext: LmuLiveContext | undefined;
    if (base.lmuContext) {
      try {
        const decoded = decodeLmuContext(base.lmuContext);
        if (!decoded) throw new Error("Invalid context");
        lmuContext = decoded;
      } catch {
        throw new LmuOpponentIndexError("BLOCK_CORRUPT", "Shared context failed lossless codec validation");
      }
    }
    if (lmuContext?.competitors) {
      const competitorsBySourceIndex = new Map(competitorEntries.map((entry, index) => [entry.competitorIndex, competitors[index]!]));
      lmuContext = {
        ...lmuContext,
        competitors: lmuContext.competitors.map((stub, sourceIndex) =>
          stub.vehicleId === interval.vehicleId && stub.incarnation === interval.incarnation
            ? competitorsBySourceIndex.get(sourceIndex) ?? stub
            : stub.isPlayer && stub.vehicleId === lmuContext!.playerVehicleId
              ? { ...stub, channels: {} }
              : stub),
      };
    }
    return {
      sessionKey: base.sessionKey,
      captureSequence: base.captureSequence,
      frameTime: base.frameTime,
      competitors,
      ...(lmuContext ? { lmuContext } : {}),
    };
  });
  stats.framesDecoded = selectedFrames.size;
  const { opponentNumericChannelIds: _channels, driverName: _driverName, carName: _carName, className: _className,
    lapTime: _lapTime, sectors: _sectors, ...intervalFields } = interval;
  return { ...intervalFields, frames, stats };
}

export async function invalidateLmuOpponentIndex(publicationPath: string): Promise<void> {
  const manifestPath = resolve(publicationPath);
  const publicationDirectory = dirname(manifestPath);
  if (basename(manifestPath) !== INDEX_FILE_NAME || !basename(publicationDirectory).startsWith(PUBLICATION_PREFIX)) {
    throw new LmuOpponentIndexError("INDEX_NOT_FOUND", "Opponent publication path must name a published index.json");
  }
  const publicationInfo = await lstat(publicationDirectory).catch((error) => {
    if (asErrno(error).code === "ENOENT") return null;
    throw error;
  });
  if (!publicationInfo) return;
  if (!publicationInfo.isDirectory() || publicationInfo.isSymbolicLink()) {
    throw new LmuOpponentIndexError("INDEX_NOT_FOUND", "Opponent publication directory is unavailable");
  }
  const quarantinePath = join(dirname(publicationDirectory), `${INVALIDATED_PREFIX}${randomUUID()}`);
  try {
    await rename(publicationDirectory, quarantinePath);
  } catch (error) {
    if (asErrno(error).code === "ENOENT") return;
    throw error;
  }
  await rm(quarantinePath, { recursive: true, force: true });
}

export async function cleanupLmuOpponentIndexStaging(indexRoot: string): Promise<string[]> {
  const root = resolve(indexRoot);
  const rootInfo = await lstat(root).catch((error) => {
    if (asErrno(error).code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return [];
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent index root is not a managed directory");
  }
  const entries = await readdir(root, { withFileTypes: true });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
    const path = join(root, entry.name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

function artifactKind(root: string, path: string): LmuOpponentIndexArtifact["kind"] {
  const artifactPath = relative(root, path);
  if (artifactPath === "state.json") return "state";
  const directory = artifactPath.split(sep, 1)[0]!;
  if (directory.startsWith(PUBLICATION_PREFIX)) return "publication";
  if (directory.startsWith(STAGING_PREFIX)) return "staging";
  if (directory.startsWith(INVALIDATED_PREFIX)) return "invalidated";
  return "other";
}

async function collectIndexArtifacts(root: string, directory: string): Promise<LmuOpponentIndexArtifact[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const artifacts: LmuOpponentIndexArtifact[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...await collectIndexArtifacts(root, path));
    } else if (entry.isFile()) {
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) {
        artifacts.push({ path, kind: artifactKind(root, path), bytes: info.size });
      }
    }
  }
  return artifacts;
}

export async function getLmuOpponentIndexDiskUsage(indexRoot: string): Promise<number> {
  const inventory = await inventoryLmuOpponentIndex(indexRoot);
  return inventory.totalBytes;
}

export async function inventoryLmuOpponentIndex(indexRoot: string): Promise<LmuOpponentIndexInventory> {
  const rootPath = resolve(indexRoot);
  const rootInfo = await lstat(rootPath).catch((error) => {
    if (asErrno(error).code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return { rootPath, artifacts: [], totalBytes: 0 };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new LmuOpponentIndexError("INDEX_CORRUPT", "Opponent index root is not a managed directory");
  }
  const artifacts = await collectIndexArtifacts(rootPath, rootPath);
  return { rootPath, artifacts, totalBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) };
}
