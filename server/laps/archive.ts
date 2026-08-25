/**
 * Lap / session ZIP export + import.
 *
 * Telemetry is NOT stored as a per-lap blob any more — the canonical source is
 * the per-session raw capture on disk (`sessions.rawFile`: optional 12-byte
 * meta frame, then repeated `[uint32 LE len][frame bytes]`), with each lap row
 * pointing at a `rawByteOffset` / `rawFrameCount` window inside it.
 *
 * So an export is just a slice of that frame stream, and an import replays the
 * slice through the normal pipeline (`importSessionBin`) — the exact same code
 * path as the single-file `.bin` import. Nothing here re-implements parsing or
 * lap detection, which is what the old CSV-blob format did (and why it rotted).
 *
 * Zip layout:
 *   manifest.json                              — describes every entry
 *   <gameId>-<track>-session<id>.bin.gz        — one gzip'd frame slice per session
 */
import { zipSync, unzipSync } from "fflate";
import type { SessionOwnership } from "../../shared/racing/sessions/types";
import { getLapsRaw } from "../db/lap-read-queries";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { detectGameIdFromBuffer, detectGameIdFromFilename, importSessionBin } from "../session-capture/import-capture";
import type { ImportedLap } from "../session-capture/import-pipeline";
import { advanceSessionFrames, countSessionFrames, encodeMetaFrame, gzipBufferSync, gunzipBufferSync, readFrameStreamStart, sessionFrameAt } from "../session-capture/framing";
import { sha256ContentHash } from "../session-capture/identity";
import {
  LOCAL_PLAYER_EVIDENCE,
  SOURCE_CHANNEL_PROFILE_VERSION,
  normalizeEvidenceSourceKind,
  type ArchiveVerification,
  type EvidenceSourceKind,
  type ParticipantEvidence,
  type SourceChannelProfile,
  type SourceChannelTreatment,
} from "../../shared/racing/quality/contracts";
import type { MappingStatus } from "../../shared/telemetry/derivations/contracts";
import { isIRacingSessionFrame } from "../games/iracing/source-frame";
import { GameIdSchema, type GameId } from "../../shared/games/ids";

/** Bumped when the zip layout changes in a way older readers can't handle. */
export const LAPS_ZIP_VERSION = 3;

export interface ManifestLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
}

export interface ManifestEntry {
  /** Zip entry name holding this session's gzip'd frame slice. */
  file: string;
  gameId: GameId;
  /** Session id in the *source* database (informational — import always creates a new session). */
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
  carName: string;
  trackName: string;
  createdAt: string;
  laps: ManifestLap[];
  memberSha256?: string;
  sourceKind?: EvidenceSourceKind;
  participant?: ParticipantEvidence;
  sourceChannelProfile?: SourceChannelProfile;
  sourceVerification?: ArchiveVerification;
  recordingQualitySchemaVersion?: string;
  sourceGeneration?: string;
}

export interface LapsZipManifest {
  version: number;
  exportedAt: string;
  entries: ManifestEntry[];
}

type RawLapRow = Awaited<ReturnType<typeof getLapsRaw>>[number];

const MANIFEST_FILE_NAME = "manifest.json";
const manifestTextEncoder = new TextEncoder();
const manifestTextDecoder = new TextDecoder();

const EVIDENCE_SOURCE_KINDS: Record<EvidenceSourceKind, true> = {
  "native-live": true,
  "raceiq-raw": true,
  "raceiq-archive": true,
  "canonical-archive": true,
  "iracing-ibt": true,
  motec: true,
  "remote-collector": true,
  "external-log": true,
  unknown: true,
};
const SOURCE_CHANNEL_TREATMENTS: Record<SourceChannelTreatment, true> = {
  direct: true,
  held: true,
  resampled: true,
  "dead-reckoned": true,
  assumed: true,
  absent: true,
};
const MAPPING_STATUSES: Record<MappingStatus, true> = {
  direct: true,
  normalized: true,
  derived: true,
  simplified: true,
  unavailable: true,
};
const ARCHIVE_VERIFICATION_STATES: Record<ArchiveVerification["state"], true> = {
  verified: true,
  truncated: true,
  corrupt: true,
  unavailable: true,
  unknown: true,
};
const PARTICIPANT_KINDS: Record<ParticipantEvidence["kind"], true> = {
  player: true,
  opponent: true,
};
const PARTICIPANT_IDENTITY_STATES: Record<ParticipantEvidence["identityState"], true> = {
  stable: true,
  "session-scoped": true,
  unknown: true,
};

function isArchiveVerification(value: unknown): value is ArchiveVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const verification = value as Record<string, unknown>;
  return (
    typeof verification.state === "string" &&
    Object.hasOwn(ARCHIVE_VERIFICATION_STATES, verification.state) &&
    (verification.sourceGeneration === null || typeof verification.sourceGeneration === "string") &&
    (verification.details === undefined || typeof verification.details === "string")
  );
}

function isEvidenceSourceKind(value: unknown): value is EvidenceSourceKind {
  return typeof value === "string" && Object.hasOwn(EVIDENCE_SOURCE_KINDS, value);
}

function isParticipantEvidence(value: unknown): value is ParticipantEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const participant = value as Record<string, unknown>;
  return (
    typeof participant.kind === "string" &&
    Object.hasOwn(PARTICIPANT_KINDS, participant.kind) &&
    (participant.sourceId === null || typeof participant.sourceId === "string") &&
    (participant.stableId === null || typeof participant.stableId === "string") &&
    typeof participant.identityState === "string" &&
    Object.hasOwn(PARTICIPANT_IDENTITY_STATES, participant.identityState)
  );
}

function isSourceChannelProfile(value: unknown): value is SourceChannelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (
    profile.schemaVersion !== SOURCE_CHANNEL_PROFILE_VERSION ||
    !isEvidenceSourceKind(profile.sourceKind) ||
    !profile.channels ||
    typeof profile.channels !== "object" ||
    Array.isArray(profile.channels)
  ) {
    return false;
  }
  return Object.values(profile.channels).every((channelValue) => {
    if (!channelValue || typeof channelValue !== "object" || Array.isArray(channelValue)) return false;
    const channel = channelValue as Record<string, unknown>;
    return (
      typeof channel.treatment === "string" &&
      Object.hasOwn(SOURCE_CHANNEL_TREATMENTS, channel.treatment) &&
      typeof channel.mappingStatus === "string" &&
      Object.hasOwn(MAPPING_STATUSES, channel.mappingStatus) &&
      Array.isArray(channel.sourceChannels) &&
      channel.sourceChannels.every(
        (source) =>
          !!source &&
          typeof source === "object" &&
          !Array.isArray(source) &&
          typeof (source as Record<string, unknown>).name === "string" &&
          ((source as Record<string, unknown>).declaredHz === null || typeof (source as Record<string, unknown>).declaredHz === "number") &&
          ((source as Record<string, unknown>).effectiveHz === null || typeof (source as Record<string, unknown>).effectiveHz === "number"),
      ) &&
      Array.isArray(channel.limitations) &&
      channel.limitations.every((limitation) => typeof limitation === "string") &&
      typeof channel.evidenceId === "string"
    );
  });
}

function parseManifestFile(files: Record<string, Uint8Array>): LapsZipManifest | null {
  if (!(MANIFEST_FILE_NAME in files)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestTextDecoder.decode(files[MANIFEST_FILE_NAME]));
  } catch {
    throw new Error("Invalid RaceIQ archive manifest");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid RaceIQ archive manifest");
  }

  const manifest = parsed as Record<string, unknown>;
  if (!Number.isInteger(manifest.version) || typeof manifest.exportedAt !== "string" || !Array.isArray(manifest.entries)) {
    throw new Error("Invalid RaceIQ archive manifest");
  }
  for (const entryValue of manifest.entries) {
    if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
      throw new Error("Invalid RaceIQ archive manifest");
    }
    const entry = entryValue as Record<string, unknown>;
    if (
      typeof entry.file !== "string" ||
      entry.file.length === 0 ||
      typeof entry.gameId !== "string" ||
      !GameIdSchema.safeParse(entry.gameId).success ||
      typeof entry.sessionId !== "number" ||
      typeof entry.carOrdinal !== "number" ||
      typeof entry.trackOrdinal !== "number" ||
      typeof entry.carName !== "string" ||
      typeof entry.trackName !== "string" ||
      typeof entry.createdAt !== "string" ||
      !Array.isArray(entry.laps) ||
      (entry.sourceKind !== undefined && !isEvidenceSourceKind(entry.sourceKind)) ||
      (entry.participant !== undefined && !isParticipantEvidence(entry.participant)) ||
      (entry.sourceVerification !== undefined && !isArchiveVerification(entry.sourceVerification)) ||
      (entry.sourceChannelProfile !== undefined && (!isSourceChannelProfile(entry.sourceChannelProfile) || entry.sourceKind !== entry.sourceChannelProfile.sourceKind))
    ) {
      throw new Error("Invalid RaceIQ archive manifest");
    }
    for (const lapValue of entry.laps) {
      if (!lapValue || typeof lapValue !== "object" || Array.isArray(lapValue)) {
        throw new Error("Invalid RaceIQ archive manifest");
      }
      const lap = lapValue as Record<string, unknown>;
      if (typeof lap.lapNumber !== "number" || typeof lap.lapTime !== "number" || typeof lap.isValid !== "boolean") {
        throw new Error("Invalid RaceIQ archive manifest");
      }
    }
  }
  return manifest as unknown as LapsZipManifest;
}

function validateStrictArchiveLayout(files: Record<string, Uint8Array>, manifest: LapsZipManifest): void {
  const entryFiles = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry.file.endsWith(".bin") && !entry.file.endsWith(".bin.gz")) {
      throw new Error(`Invalid RaceIQ archive manifest: version ${manifest.version} strict layout only allows .bin/.bin.gz capture entries`);
    }
    if (entryFiles.has(entry.file)) {
      throw new Error(`Invalid RaceIQ archive manifest: version ${manifest.version} strict layout contains duplicate member names`);
    }
    entryFiles.add(entry.file);
    if (!Object.hasOwn(files, entry.file)) {
      throw new Error(`Invalid RaceIQ archive manifest: version ${manifest.version} strict layout declares a missing capture member`);
    }
    if (!entry.memberSha256 || !/^sha256:[0-9a-f]{64}$/.test(entry.memberSha256)) {
      throw new Error(`Invalid RaceIQ archive manifest: version ${manifest.version} strict layout capture member is missing a valid checksum`);
    }
  }

  for (const name of Object.keys(files)) {
    if (name !== MANIFEST_FILE_NAME && !entryFiles.has(name)) {
      throw new Error(`Invalid RaceIQ archive manifest: version ${manifest.version} strict layout contains an undeclared member`);
    }
  }

  for (const entry of manifest.entries) {
    const member = files[entry.file];
    if (sha256ContentHash(Buffer.from(member.buffer, member.byteOffset, member.byteLength)) !== entry.memberSha256) {
      throw new Error(`Invalid RaceIQ archive manifest: version ${manifest.version} capture member checksum mismatch`);
    }
  }
}

function encodeManifestFile(manifest: LapsZipManifest): Uint8Array {
  return manifestTextEncoder.encode(JSON.stringify(manifest, null, 2));
}

/**
 * Read capture bytes from disk and decompress gzip raw files.
 * Returns null when the file is missing or unreadable.
 */
async function readCapture(rawFile: string): Promise<Buffer | null> {
  try {
    const file = Bun.file(rawFile);
    if (!(await file.exists())) return null;
    const bytes = Buffer.from(await file.arrayBuffer());
    return rawFile.endsWith(".gz") ? gunzipBufferSync(bytes) : bytes;
  } catch {
    return null;
  }
}

function captureFileName(memberName: string): string {
  const idx = memberName.lastIndexOf("/");
  return idx >= 0 ? memberName.slice(idx + 1) : memberName;
}

function fileNamesForZip(files: Record<string, Uint8Array>): string[] {
  return Object.keys(files)
    .filter((name) => name.endsWith(".bin") || name.endsWith(".bin.gz"))
    .sort();
}

function parseCaptureGameId(memberName: string, bytes: Buffer, manifestGame: ReadonlyMap<string, GameId>): GameId | null {
  return detectGameIdFromBuffer(bytes) ?? manifestGame.get(memberName) ?? detectGameIdFromFilename(captureFileName(memberName));
}
export interface LapsZipDetection {
  isRaceIqArchive: boolean;
  captureCount: number;
  gameIds: GameId[];
}

/** Inspect archive contents without importing any captures. */
export function detectLapsZip(zipData: Uint8Array): LapsZipDetection {
  const files = unzipSync(zipData);
  const names = fileNamesForZip(files);
  const manifest = parseManifestFile(files);
  const manifestGame = new Map<string, GameId>();
  for (const entry of manifest?.entries ?? []) manifestGame.set(entry.file, entry.gameId);
  const gameIds = [...new Set(names.map((name) => parseCaptureGameId(name, Buffer.from(files[name]), manifestGame)).filter((gameId): gameId is GameId => gameId != null))];
  return { isRaceIqArchive: names.length > 0, captureCount: names.length, gameIds };
}

function selectedLapsBySession(rows: ReadonlyArray<RawLapRow>, wantedIds: ReadonlySet<number>): Map<number, RawLapRow[]> {
  const map = new Map<number, RawLapRow[]>();
  for (const row of rows) {
    if (!wantedIds.has(row.id)) continue;
    const sessionRows = map.get(row.sessionId);
    if (sessionRows) sessionRows.push(row);
    else map.set(row.sessionId, [row]);
  }
  return map;
}

function usableRawLaps(rows: RawLapRow[]): RawLapRow[] {
  return rows.filter((row) => row.rawFile && row.rawByteOffset != null && (row.rawFrameCount ?? 0) > 0);
}

/**
 * iRacing value frames depend on the latest packed session frame. Exports can
 * begin at a later lap, so carry that one length-prefixed header record into
 * the slice instead of replaying every preceding telemetry frame.
 */
function latestIRacingSessionRecord(buf: Buffer, beforeOffset: number): Buffer | null {
  let offset = readFrameStreamStart(buf);
  let latest: Buffer | null = null;
  while (offset < beforeOffset) {
    const frame = sessionFrameAt(buf, offset);
    if (!frame) break;
    const recordEnd = offset + 4 + frame.length;
    if (recordEnd > beforeOffset) break;
    if (isIRacingSessionFrame(frame)) {
      latest = Buffer.from(buf.subarray(offset, recordEnd));
    }
    offset = recordEnd;
  }
  return latest;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a zip containing the raw frames for the given laps, grouped by session.
 *
 * Per session the slice spans from the first selected lap's frames through the
 * last selected lap's frames *plus one trigger frame*, so the importing lap
 * detector sees the crossing that completes the final lap. Cherry-picking
 * non-adjacent laps therefore also carries the laps in between — a contiguous
 * frame stream is what makes the capture replayable, and the manifest lists
 * exactly what will come back.
 *
 * Laps with no raw capture (pre-migration rows, or a capture deleted off disk)
 * are skipped.
 */
export async function buildLapsZip(lapIds: number[]): Promise<{ bytes: Uint8Array; manifest: LapsZipManifest }> {
  const wanted = new Set(lapIds);
  const allRows = await getLapsRaw();
  const sessions = selectedLapsBySession(allRows, wanted);
  if (sessions.size === 0) throw new Error("No laps matched the requested ids");

  const files: Record<string, Uint8Array> = {};
  const entries: ManifestEntry[] = [];

  for (const [sessionId, rows] of sessions) {
    const usable = usableRawLaps(rows);
    if (usable.length === 0) continue;

    const rawFile = usable[0].rawFile as string;
    const buf = await readCapture(rawFile);
    if (!buf) continue; // capture gone from disk — nothing to export for this session

    const first = usable[0];
    let startByte = first.rawByteOffset as number;
    let last = first;
    for (let i = 1; i < usable.length; i++) {
      const row = usable[i];
      const offset = row.rawByteOffset as number;
      if (offset < startByte) startByte = offset;
      if (offset > (last.rawByteOffset as number)) last = row;
    }
    if (startByte >= buf.length) continue;
    // +1 frame: the next-lap trigger that completes the final lap on replay.
    const endByte = advanceSessionFrames(buf, last.rawByteOffset as number, (last.rawFrameCount as number) + 1);

    const gameId = first.gameId as GameId;
    const firstFrame = sessionFrameAt(buf, startByte);
    const sessionPrefix = gameId === "iracing" && firstFrame && !isIRacingSessionFrame(firstFrame) ? latestIRacingSessionRecord(buf, startByte) : null;
    const telemetrySlice = buf.subarray(startByte, endByte);
    const sliceFrameCount = countSessionFrames(telemetrySlice, 0) + (sessionPrefix ? 1 : 0);
    const slice = Buffer.concat(sessionPrefix ? [encodeMetaFrame(sliceFrameCount), sessionPrefix, telemetrySlice] : [encodeMetaFrame(sliceFrameCount), telemetrySlice]);

    const trackName = resolveTrackName(first.trackOrdinal ?? -1, gameId);
    const carName = resolveCarName(first.carOrdinal ?? -1, gameId);
    // Filename MUST start with `<gameId>-` so import can fall back to
    // filename-based game detection.
    const fileName = `${gameId}-${slugify(trackName) || `track${first.trackOrdinal ?? 0}`}-session${sessionId}.bin.gz`;

    const compressedSlice = gzipBufferSync(slice);
    files[fileName] = compressedSlice;

    // Everything inside the exported span comes back on import — list it all.
    const covered = allRows.filter((r) => r.sessionId === sessionId && r.rawByteOffset != null && r.rawByteOffset >= startByte && r.rawByteOffset < endByte).sort((a, b) => a.lapNumber - b.lapNumber);

    entries.push({
      file: fileName,
      gameId,
      sessionId,
      carOrdinal: first.carOrdinal ?? 0,
      trackOrdinal: first.trackOrdinal ?? 0,
      carName,
      trackName,
      createdAt: first.createdAt,
      memberSha256: sha256ContentHash(compressedSlice),
      sourceKind: normalizeEvidenceSourceKind(first.source),
      participant: first.recordingQuality?.participant ?? LOCAL_PLAYER_EVIDENCE,
      sourceChannelProfile: first.sourceChannelProfile ?? undefined,
      sourceVerification: first.recordingQuality?.archiveVerification ?? {
        state: "unknown",
        sourceGeneration: first.recordingQuality?.provenance.sourceGeneration ?? "legacy",
        details: "Source quality verification was unavailable during export",
      },
      recordingQualitySchemaVersion: first.recordingQualitySchemaVersion ?? "legacy",
      sourceGeneration: first.recordingQuality?.provenance.sourceGeneration ?? "legacy",
      laps: covered.map((r) => ({
        lapNumber: r.lapNumber,
        lapTime: r.lapTime,
        isValid: r.isValid,
      })),
    });
  }

  if (entries.length === 0) {
    throw new Error("None of the selected laps have a raw capture available to export");
  }

  const manifest: LapsZipManifest = {
    version: LAPS_ZIP_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  };
  files[MANIFEST_FILE_NAME] = encodeManifestFile(manifest);

  // level 0 for the .bin.gz members (already gzip'd), default for the manifest.
  const bytes = zipSync(files, { level: 6 });
  return { bytes, manifest };
}

/** `raceiq-<track>-<n>laps-<date>.zip`, or a generic name for a mixed export. */
export function lapsZipFilename(manifest: LapsZipManifest): string {
  const date = manifest.exportedAt.slice(0, 10);
  const lapCount = manifest.entries.reduce((sum, e) => sum + e.laps.length, 0);
  const tracks = new Set(manifest.entries.map((e) => e.trackName));
  const trackPart = tracks.size === 1 ? `${slugify(tracks.values().next().value as string)}-` : "";
  return `raceiq-${trackPart}${lapCount}lap${lapCount === 1 ? "" : "s"}-${date}.zip`;
}

export interface ImportZipResult {
  imported: number;
  skipped: number;
  laps: ImportedLap[];
  errors: string[];
}

/**
 * Import a zip produced by {@link buildLapsZip}: every `.bin`/`.bin.gz` member is
 * replayed through the pipeline, landing as a fresh session with its laps
 * re-detected. Duplicates are not merged — importing the same zip twice gives
 * you the laps twice, same as the single-file `.bin` import.
 */
export async function importLapsZip(zipData: Uint8Array, options: { ownership?: SessionOwnership } = {}): Promise<ImportZipResult> {
  const files = unzipSync(zipData);

  const manifest = parseManifestFile(files);
  if (manifest && manifest.version !== 1 && manifest.version !== 2 && manifest.version !== LAPS_ZIP_VERSION) {
    throw new Error(`Unsupported RaceIQ archive version ${manifest.version}`);
  }
  const manifestGame = new Map<string, GameId>();
  const manifestEntries = new Map<string, ManifestEntry>();
  for (const entry of manifest?.entries ?? []) {
    manifestGame.set(entry.file, entry.gameId);
    manifestEntries.set(entry.file, entry);
  }

  const laps: ImportedLap[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const names = fileNamesForZip(files);

  if (manifest?.version === LAPS_ZIP_VERSION) {
    validateStrictArchiveLayout(files, manifest);
  }
  if (names.length === 0) {
    throw new Error("Zip contains no session captures (.bin/.bin.gz). Exports from an older RaceIQ version can't be imported.");
  }

  for (const name of names) {
    const memberBytes = files[name];
    const bytes = Buffer.from(memberBytes.buffer, memberBytes.byteOffset, memberBytes.byteLength);
    const entry = manifestEntries.get(name);
    try {
      const gameId = parseCaptureGameId(name, bytes, manifestGame);
      if (!gameId) {
        throw new Error("could not determine which game this capture came from");
      }
      const preservesSourceFidelity = manifest?.version === LAPS_ZIP_VERSION;
      const sourceVerification = preservesSourceFidelity
        ? (entry?.sourceVerification ?? {
            state: "unknown" as const,
            sourceGeneration: entry?.sourceGeneration ?? "legacy",
            details: "Archive manifest does not include original source verification",
          })
        : {
            state: "unknown" as const,
            sourceGeneration: "legacy",
            details: "Archive predates member checksums",
          };
      const result = await importSessionBin(bytes, gameId, {
        ownership: options.ownership,
        sourceKind: preservesSourceFidelity ? (entry?.sourceKind ?? "unknown") : "raceiq-archive",
        participant: preservesSourceFidelity ? (entry?.participant ?? LOCAL_PLAYER_EVIDENCE) : LOCAL_PLAYER_EVIDENCE,
        sourceChannelProfile: preservesSourceFidelity ? entry?.sourceChannelProfile : undefined,
        sourceArchiveVerification: sourceVerification,
        sourceTransportVerification: preservesSourceFidelity
          ? {
              state: "verified",
              sourceGeneration: entry?.memberSha256 ?? sha256ContentHash(bytes),
            }
          : undefined,
      });
      laps.push(...result.laps);
    } catch (err) {
      skipped++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported: laps.length, skipped, laps, errors };
}
