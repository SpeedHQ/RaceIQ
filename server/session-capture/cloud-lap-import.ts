import { classifyLapAttribution } from "@raceiq/shared/driver-attribution";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { api, createRaceIqClient } from "@speedhq/live-client";
import { unzipBounded, type ZipExtractionLimits } from "../archive/bounded-unzip";
import { db } from "../db/index";
import { laps, sessions, lapGuidReconciliation, originalActivitySourceLaps } from "../db/schema";
import { resolveDataDir } from "../runtime/config/data-dir";
import { resolveRecordingDirectory, resolveRecordingGameDirectory } from "../runtime/config/recording-directory";
import { validateCloudImportCapture } from "./cloud-import-admission";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import type { CloudLapImportSelection, CloudLapImportStatus } from "@raceiq/shared/integrations/cloud-lap-import";
import { GameIdSchema, type GameId } from "@raceiq/shared/games/ids";

import { stintSchema } from "./portable-metadata";
const MiB = 1024 * 1024;
const MAX_ZIP_BYTES = 512 * MiB;
const MAX_CAPTURE_BYTES = 512 * MiB;
const LIMITS: ZipExtractionLimits = { maxArchiveBytes: MAX_ZIP_BYTES, maxEntries: 3, maxEntryBytes: MAX_CAPTURE_BYTES, maxTotalBytes: MAX_CAPTURE_BYTES + 2 * MiB, strictEntryNames: true };
const utcDatetime = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));
const manifestSchema = z.object({
  schemaVersion: z.literal(3),
  author: z.object({ userId: z.string().min(1), displayName: z.string().min(1) }).strict(),
  lap: z.object({
    id: z.string().min(1), guid: z.string().uuid(), gameId: z.enum(["acc", "ac-evo", "f1-2025", "iracing", "lmu"]), trackId: z.string().min(1), carId: z.string().min(1),
    totalTimeMs: z.number().int().positive().safe(), sectorTimesMs: z.array(z.number().int().positive().safe()).min(1).max(64), complete: z.literal(true), valid: z.literal(true), invalidReason: z.string().nullable(),
    recordedAt: utcDatetime.nullable(), setAt: utcDatetime, lapIndex: z.number().int().nonnegative().safe(), sessionKey: z.number().int().nonnegative().safe(), sessionUID: z.string().nullable(), sourceLapIndex: z.number().int().nonnegative().safe(), sourceSessionKey: z.number().int().nonnegative().safe(),
  }).strict(),
  recording: z.object({ path: z.literal("recording.bin"), format: z.literal("raceiq-session"), frameVersion: z.literal("1"), compression: z.literal("gzip"), sizeBytes: z.number().int().positive().safe() }).strict(),
  processing: z.object({ lapDetectorVersion: z.string().min(1), sourceFrameFormat: z.string().min(1), sourceFrameVersion: z.string().nullable() }).strict(),
  setup: z.object({ path: z.string().regex(/^setup\/[^/\\]+$/), fileName: z.string().min(1), sizeBytes: z.number().int().positive().max(MiB) }).strict().nullable(),
  provenance: z.object({
    originalActivityId: z.string().min(1).nullable(),
    sourceRevision: z.string().min(1).nullable(),
    sourceClock: z.object({ domain: z.string().min(1), startMs: z.number().finite(), endMs: z.number().finite() })
      .strict().refine((clock) => clock.endMs >= clock.startMs).nullable(),
    driverAttributionStints: z.array(stintSchema.transform(({ bindingSnapshot: _bindingSnapshot, ...stint }) => stint)).nullable(),
  }).strict().optional(),
}).strict();

export class CloudLapImportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

const active = new Map<string, Promise<CloudLapImportResult>>();
const ORIGIN = "https://raceiq.snazzie.space";

export interface CloudLapImportOptions {
  /** Test-only origin override; production calls must use the fixed HTTPS origin. */
  origin?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CloudLapImportIdentity extends CloudLapImportSelection { lapGuid: string }
export interface CloudLapImportResult { id: number; gameId: string; sessionId: number }
export interface CloudLapImportInput {
  lapId: string;
  sourceUrl?: string | null;
  accessToken: string;
  expectedSelection: CloudLapImportIdentity | null;
  isAuthorized(): boolean;
  assertAuthorized(): Promise<void>;
  onIdentity(identity: CloudLapImportIdentity): void;
  onState(status: Exclude<CloudLapImportStatus, "idle" | "awaiting_sign_in" | "complete" | "error">): void;
}
export function createCloudLapImporter(options: CloudLapImportOptions = {}): (input: CloudLapImportInput) => Promise<CloudLapImportResult> {
  const origin = options.origin === undefined ? ORIGIN : validateImportOrigin(options.origin);
  return (input) => importCloudLapWithOptions(input, origin, options.fetch);
}

function validateImportOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CloudLapImportError("invalid_url", false); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.protocol !== "http:" || !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname))
    throw new CloudLapImportError("invalid_url", false);
  return url.origin;
}

export function validateCloudLapImportUrl(value: string): string {
  return validateCloudLapImportUrlAtOrigin(value, ORIGIN);
}

function validateCloudLapImportUrlAtOrigin(value: string, origin: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CloudLapImportError("invalid_url", false); }
  const trusted = new URL(origin);
  const match = /^\/api\/v1\/laps\/([^/]+)\/import\.zip$/.exec(url.pathname);
  if (url.protocol !== trusted.protocol || url.origin !== trusted.origin || url.username || url.password || url.search || url.hash || !match) throw new CloudLapImportError("invalid_url", false);
  let lapId: string;
  try { lapId = decodeURIComponent(match[1]!); } catch { throw new CloudLapImportError("invalid_url", false); }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(lapId)) throw new CloudLapImportError("invalid_url", false);
  return lapId;
}

export function importCloudLap(input: CloudLapImportInput): Promise<CloudLapImportResult> {
  return importCloudLapWithOptions(input, ORIGIN);
}

function confirmImportIdentity(input: CloudLapImportInput, value: { lapGuid: string; gameId: string; trackId: string; carId: string }): void {
  const game = GameIdSchema.safeParse(value.gameId);
  const guid = z.string().uuid().safeParse(value.lapGuid);
  if (!game.success || game.data === "fm-2023") throw new CloudLapImportError("unsupported_game", false);
  if (!guid.success || !value.trackId || !value.carId) throw new CloudLapImportError("lap_identity_conflict", false);
  const identity = { lapGuid: guid.data.toLowerCase(), gameId: game.data, trackId: value.trackId, carId: value.carId };
  const expected = input.expectedSelection;
  if (expected && (expected.lapGuid.toLowerCase() !== identity.lapGuid || expected.gameId !== identity.gameId ||
      expected.trackId !== identity.trackId || expected.carId !== identity.carId)) throw new CloudLapImportError("lap_identity_conflict", false);
  input.onIdentity(Object.freeze(identity));
}

async function confirmSavedImportIdentity(input: CloudLapImportInput, lapId: number): Promise<CloudLapImportResult> {
  const row = await db.select({ id: laps.id, sessionId: sessions.id, lapGuid: laps.lapGuid, canonicalGuid: lapGuidReconciliation.lapGuid, status: lapGuidReconciliation.status,
    gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId }).from(laps)
    .innerJoin(sessions, eq(sessions.id, laps.sessionId)).leftJoin(lapGuidReconciliation, eq(lapGuidReconciliation.lapId, laps.id))
    .where(eq(laps.id, lapId)).get();
  await input.assertAuthorized();
  if (!row?.lapGuid || row.status !== "resolved" || row.canonicalGuid?.toLowerCase() !== row.lapGuid.toLowerCase()) {
    throw new CloudLapImportError("lap_identity_conflict", false);
  }
  confirmImportIdentity(input, { ...row, lapGuid: row.lapGuid });
  return { id: row.id, gameId: row.gameId, sessionId: row.sessionId };
}

async function importCloudLapWithOptions(input: CloudLapImportInput, origin: string, fetcher?: typeof globalThis.fetch): Promise<CloudLapImportResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.lapId)) throw new CloudLapImportError("invalid_url", false);
  if (input.expectedSelection?.gameId === "fm-2023") throw new CloudLapImportError("unsupported_game", false);
  const requestedId = input.sourceUrl ? validateCloudLapImportUrlAtOrigin(input.sourceUrl, origin) : input.lapId;
  if (requestedId !== input.lapId) throw new CloudLapImportError("lap_id_mismatch", false);
  await input.assertAuthorized();
  await recoverCloudLapImports();
  await input.assertAuthorized();
  const key = `${origin}\0${input.lapId}`;
  const found = await db.select({ id: laps.id, lapGuid: laps.lapGuid, guidStatus: lapGuidReconciliation.status,
    canonicalGuid: lapGuidReconciliation.lapGuid, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId,
    sessionId: sessions.id, rawFile: sessions.rawFile })
    .from(sessions).innerJoin(laps, eq(laps.sessionId, sessions.id))
    .leftJoin(lapGuidReconciliation, eq(lapGuidReconciliation.lapId, laps.id))
    .where(and(eq(sessions.cloudImportOrigin, origin), eq(sessions.cloudImportLapId, input.lapId))).get();
  await input.assertAuthorized();
  if (found?.rawFile && found.lapGuid && found.guidStatus === "resolved") {
    let available = false;
    try { await access(found.rawFile); available = true; } catch { /* Missing bytes may be restored without changing identity. */ }
    await input.assertAuthorized();
    if (available) {
      const result = await confirmSavedImportIdentity(input, found.id);
      await input.assertAuthorized();
      return result;
    }
  }
  const joined = active.get(key);
  if (joined) {
    const result = await joined;
    await input.assertAuthorized();
    const current = await confirmSavedImportIdentity(input, result.id);
    await input.assertAuthorized();
    return current;
  }
  const run = performImport(input, origin, fetcher).finally(() => active.delete(key));
  active.set(key, run);
  return run;
}
interface CloudImportJournal {
  version: 1;
  origin: string;
  lapId: string;
  gameId: string;
  temp: string;
  final: string;
  setupTemp: string | null;
  setupFinal: string | null;
}

let recoveredRoot: string | null = null;
/** Recover interrupted cloud publication once before accepting imports in this data directory. */
export async function recoverCloudLapImports(): Promise<void> {
  const root = `${resolveDataDir()}\0${resolveRecordingDirectory()}`;
  if (recoveredRoot === root) return;
  await withSessionCaptureMaintenanceLock(async () => {
    if (recoveredRoot === root) return;
    await recoverCloudImportJournals();
    recoveredRoot = root;
  });
}

async function recoverCloudImportJournals(): Promise<void> {
  const root = resolveDataDir();
  const recordingRoot = resolveRecordingDirectory();
  await mkdir(root, { recursive: true });
  for (const name of await readdir(root)) {
    if (!/^\.cloud-import-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const journalPath = join(root, name);
    let journal: CloudImportJournal;
    try {
      const parsed: unknown = JSON.parse(await readFile(journalPath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("invalid journal");
      journal = parsed as CloudImportJournal;
      if (journal.version !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(journal.lapId) ||
          !/^[a-z0-9-]+$/.test(journal.gameId)) throw new Error("invalid journal");
      const dir = dirname(journal.final);
      if (dir !== resolve(recordingRoot, journal.gameId, "others") && dir !== resolve(recordingRoot, journal.gameId)) {
        throw new Error("invalid journal directory");
      }
      const owned = (path: string, pattern: RegExp) => {
        if (!isAbsolute(path) || dirname(path) !== dir) return false;
        const rel = relative(recordingRoot, path);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
        return pattern.test(basename(path));
      };
      if (!owned(journal.temp, /^\.cloud-[0-9a-f-]{36}\.bin\.gz\.part$/) ||
          !owned(journal.final, /^cloud-[0-9a-f-]{36}\.bin\.gz$/) ||
          (journal.setupTemp !== null && !owned(journal.setupTemp, /^\.cloud-[0-9a-f-]{36}\.setup\.part$/)) ||
          (journal.setupFinal !== null && !owned(journal.setupFinal, /^cloud-[0-9a-f-]{36}\.setup$/))) throw new Error("invalid journal paths");
    } catch {
      // Untrusted or malformed journal paths are never used for deletion.
      await rm(journalPath, { force: true });
      continue;
    }
    const completed = await db.select({ rawFile: sessions.rawFile })
      .from(sessions)
      .where(and(eq(sessions.cloudImportOrigin, journal.origin), eq(sessions.cloudImportLapId, journal.lapId), eq(sessions.rawFile, journal.final))).get();
    if (!completed) {
      await rm(journal.temp, { force: true });
      await rm(journal.final, { force: true });
      if (journal.setupTemp) await rm(journal.setupTemp, { force: true });
      if (journal.setupFinal) await rm(journal.setupFinal, { force: true });
    }
    await rm(journalPath, { force: true });
  }
  for (const name of await readdir(root)) {
    if (!/^\.cloud-[0-9a-f-]{36}\.zip\.part$/.test(name)) continue;
    const path = join(root, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs > 10 * 60 * 1000) await rm(path, { force: true });
    } catch { /* Concurrent cleanup or missing file is harmless. */ }
  }
}

async function performImport(input: CloudLapImportInput, origin: string, fetcher?: typeof globalThis.fetch): Promise<CloudLapImportResult> {
  const { apiClient } = createRaceIqClient({ baseUrl: origin, ...(fetcher ? { fetch: fetcher } : {}) });
  let download;
  try {
    download = await api.downloadLapImport({ client: apiClient, path: { lapId: input.lapId }, headers: { Authorization: `Bearer ${input.accessToken}` }, redirect: "error", parseAs: "stream", signal: AbortSignal.timeout(30_000) });
  } catch { throw new CloudLapImportError("download_failed", true); }
  try { await input.assertAuthorized(); }
  catch (error) { await download.response.body?.cancel().catch(() => {}); throw error; }
  if (!download.response.ok || !download.response.body) {
    await download.response.body?.cancel().catch(() => {});
    if (download.response.status === 401) throw new CloudLapImportError("auth_required", true);
    if (download.response.status === 404) throw new CloudLapImportError("recording_unavailable", false);
    throw new CloudLapImportError("download_failed", true);
  }
  const archivePath = join(resolveDataDir(), `.cloud-${randomUUID()}.zip.part`);
  await mkdir(resolveDataDir(), { recursive: true });
  const archive = await open(archivePath, "wx", 0o600);
  let length = 0;
  let streamFailure: unknown;
  let authorizationFailure = false;
  const reader = download.response.body.getReader();
  let streamComplete = false;
  try {
    for (;;) {
      const next = await reader.read();
      try { await input.assertAuthorized(); } catch (error) { authorizationFailure = true; throw error; }
      if (next.done) { streamComplete = true; break; }
      length += next.value.byteLength;
      if (length > MAX_ZIP_BYTES) throw new CloudLapImportError("archive_too_large", false);
      await archive.writeFile(next.value);
    }
  } catch (error) {
    streamFailure = error;
  } finally {
    if (!streamComplete) await reader.cancel().catch(() => {});
    await archive.close();
  }
  if (streamFailure !== undefined) {
    await rm(archivePath, { force: true });
    if (authorizationFailure) throw streamFailure;
    if (streamFailure instanceof CloudLapImportError) throw streamFailure;
    throw new CloudLapImportError("download_failed", true);
  }
  input.onState("validating");
  let zip: Buffer;
  try { zip = await readFile(archivePath); } finally { await rm(archivePath, { force: true }); }
  await input.assertAuthorized();
  let files: Record<string, Uint8Array>;
  try { files = unzipBounded(zip, LIMITS); } catch { throw new CloudLapImportError("invalid_archive", false); }
  const names = Object.keys(files).sort();
  if (names.some((name) => name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === ".." || part === ".")) || !names.includes("manifest.json") || !names.includes("recording.bin") || names.some((name) => name !== "manifest.json" && name !== "recording.bin" && name !== "setup/opaque" && !name.startsWith("setup/"))) throw new CloudLapImportError("invalid_archive", false);
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = manifestSchema.parse(JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8"))); } catch { throw new CloudLapImportError("invalid_manifest", false); }
  if (manifest.lap.id !== input.lapId) throw new CloudLapImportError("lap_id_mismatch", false);
  confirmImportIdentity(input, { lapGuid: manifest.lap.guid, gameId: manifest.lap.gameId, trackId: manifest.lap.trackId, carId: manifest.lap.carId });
  await input.assertAuthorized();
  const provenance = manifest.provenance;
  if (provenance?.driverAttributionStints?.some((stint) => stint.gameId !== manifest.lap.gameId
    || (provenance.sourceClock !== null && stint.clockDomain !== provenance.sourceClock.domain))) throw new CloudLapImportError("invalid_manifest", false);
  const sourceAttribution = provenance?.sourceClock && provenance.driverAttributionStints
    ? classifyLapAttribution(provenance.driverAttributionStints, provenance.sourceClock.startMs, provenance.sourceClock.endMs, provenance.sourceClock.domain)
    : null;
  const originalGuid = manifest.lap.guid.toLowerCase();
  const existingOriginal = await db.select({
    id: laps.id, lapGuid: laps.lapGuid, sessionId: sessions.id, gameId: sessions.gameId,
    originalActivityId: sessions.originalActivityId,
    originalSourceRevision: sessions.originalSourceRevision,
    carId: sessions.carId, trackId: sessions.trackId, ownerUserId: sessions.ownerUserId,
    sourceAuthorUserId: sessions.sourceAuthorUserId, rawFile: sessions.rawFile,
    cloudImportOrigin: sessions.cloudImportOrigin, cloudImportLapId: sessions.cloudImportLapId,
    guidStatus: lapGuidReconciliation.status, canonicalGuid: lapGuidReconciliation.lapGuid,
  }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(lapGuidReconciliation, eq(lapGuidReconciliation.lapId, laps.id)).where(eq(laps.lapGuid, originalGuid)).get();
  if (existingOriginal) {
    if ((existingOriginal.ownerUserId ?? existingOriginal.sourceAuthorUserId) !== manifest.author.userId) throw new CloudLapImportError("lap_owner_conflict", false);
    if (existingOriginal.gameId !== manifest.lap.gameId || existingOriginal.carId !== manifest.lap.carId
      || existingOriginal.trackId !== manifest.lap.trackId
      || (provenance?.originalActivityId != null && existingOriginal.originalActivityId != null && existingOriginal.originalActivityId !== provenance.originalActivityId)
      || (provenance?.sourceRevision != null && existingOriginal.originalSourceRevision != null && existingOriginal.originalSourceRevision !== provenance.sourceRevision)) throw new CloudLapImportError("lap_identity_conflict", false);
    await input.assertAuthorized();
    if (existingOriginal.guidStatus === "resolved" && existingOriginal.canonicalGuid?.toLowerCase() === originalGuid &&
      existingOriginal.rawFile && await Bun.file(existingOriginal.rawFile).exists()
      && (existingOriginal.cloudImportOrigin !== origin || !provenance)) {
      await input.assertAuthorized();
      return { id: existingOriginal.id, sessionId: existingOriginal.sessionId, gameId: existingOriginal.gameId };
    }
    if (existingOriginal.cloudImportOrigin !== origin || existingOriginal.cloudImportLapId !== manifest.lap.id) {
      throw new CloudLapImportError("recording_unavailable", false);
    }
  }
  if (manifest.lap.sectorTimesMs.some((time) => time > manifest.lap.totalTimeMs)) throw new CloudLapImportError("invalid_manifest", false);
  const recording = Buffer.from(files["recording.bin"]!);
  if (recording.byteLength !== manifest.recording.sizeBytes || recording.byteLength > MAX_CAPTURE_BYTES) throw new CloudLapImportError("invalid_recording_size", false);
  if (manifest.setup && (files[manifest.setup.path]?.byteLength !== manifest.setup.sizeBytes || !names.includes(manifest.setup.path))) throw new CloudLapImportError("invalid_setup_size", false);
  if (names.some((name) => name.startsWith("setup/") && name !== manifest.setup?.path)) throw new CloudLapImportError("unexpected_entry", false);
  let capture: Buffer;
  try { capture = gunzipSync(recording, { maxOutputLength: MAX_CAPTURE_BYTES }); } catch { throw new CloudLapImportError("invalid_recording", false); }
  let admission: { rawByteOffset: number; rawFrameCount: number };
  try {
    admission = validateCloudImportCapture(capture, {
      gameId: manifest.lap.gameId,
      lapIndex: manifest.lap.lapIndex,
      sessionKey: manifest.lap.sessionKey,
      sessionUID: manifest.lap.sessionUID,
    });
  } catch { throw new CloudLapImportError("invalid_recording", false); }


  input.onState("registering");
  const gameId = manifest.lap.gameId as GameId;
  const directory = resolveRecordingGameDirectory(gameId, "others");
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.cloud-${randomUUID()}.bin.gz.part`);
  const final = join(directory, `cloud-${randomUUID()}.bin.gz`);
  const setupTemp = manifest.setup ? join(directory, `.cloud-${randomUUID()}.setup.part`) : null;
  const setupFinal = manifest.setup ? join(directory, `cloud-${randomUUID()}.setup`) : null;
  const journalPath = join(resolveDataDir(), `.cloud-import-${randomUUID()}.json`);
  const journalTemp = `${journalPath}.part`;
  const journal: CloudImportJournal = { version: 1, origin, lapId: manifest.lap.id, gameId, temp, final, setupTemp, setupFinal };
  let committed = false;
  try {
    const registered = await withSessionCaptureMaintenanceLock(async () => {
      await writeFile(journalTemp, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
      await rename(journalTemp, journalPath);
      await writeFile(temp, recording, { flag: "wx", mode: 0o600 });
      if (setupTemp && manifest.setup) await writeFile(setupTemp, files[manifest.setup.path]!, { flag: "wx", mode: 0o600 });
      await input.assertAuthorized();
      let result!: { id: number; gameId: string; sessionId: number };
      await db.transaction(async (tx) => {
        const prior = await tx.select({ id: sessions.id, originalActivityId: sessions.originalActivityId, originalSourceRevision: sessions.originalSourceRevision, ownerUserId: sessions.ownerUserId, sourceAuthorUserId: sessions.sourceAuthorUserId }).from(sessions)
          .where(and(eq(sessions.cloudImportOrigin, origin), eq(sessions.cloudImportLapId, manifest.lap.id))).get();
        if (!input.isAuthorized()) throw new CloudLapImportError("auth_required", true);
        let sessionId: number;
        if (prior) {
          sessionId = prior.id;
          if ((prior.ownerUserId !== null && prior.ownerUserId !== manifest.author.userId)
            || (prior.sourceAuthorUserId !== null && prior.sourceAuthorUserId !== manifest.author.userId)) throw new CloudLapImportError("lap_owner_conflict", false);
          if ((prior.originalActivityId !== null && provenance?.originalActivityId != null && prior.originalActivityId !== provenance.originalActivityId)
            || (prior.originalSourceRevision !== null && provenance?.sourceRevision != null && prior.originalSourceRevision !== provenance.sourceRevision)) throw new CloudLapImportError("lap_identity_conflict", false);
          await tx.update(sessions).set({ rawFile: final, ownerUserId: manifest.author.userId,
            originalActivityId: prior.originalActivityId ?? provenance?.originalActivityId ?? null,
            originalSourceRevision: prior.originalSourceRevision ?? provenance?.sourceRevision ?? null,
            cloudImportSetupPath: setupFinal, cloudImportSetupFileName: manifest.setup?.fileName ?? null })
            .where(eq(sessions.id, sessionId)).run();
        } else {
          const session = await tx.insert(sessions).values({
            carId: manifest.lap.carId, trackId: manifest.lap.trackId, gameId, sessionType: "cloud-import", rawFile: final,
            lapDetectorVersion: manifest.processing.lapDetectorVersion, source: "cloud-import", ownership: "others",
            sourceAuthorUserId: manifest.author.userId, sourceAuthorDisplayName: manifest.author.displayName,
            ownerUserId: manifest.author.userId,
            originalActivityId: provenance?.originalActivityId ?? null,
            originalSourceRevision: provenance?.sourceRevision ?? null,
            cloudImportOrigin: origin, cloudImportLapId: manifest.lap.id,
            cloudImportSessionKey: manifest.lap.sessionKey, cloudImportSessionUid: manifest.lap.sessionUID,
            cloudImportSourceLapIndex: manifest.lap.sourceLapIndex, cloudImportSourceSessionKey: manifest.lap.sourceSessionKey,
            sourceFrameFormat: manifest.processing.sourceFrameFormat, sourceFrameVersion: manifest.processing.sourceFrameVersion,
            cloudImportSetupPath: setupFinal, cloudImportSetupFileName: manifest.setup?.fileName ?? null, captureFormatVersion: 1,
          }).returning({ id: sessions.id }).get();
          sessionId = session.id;
        }
        let lap = await tx.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).get();
        if (!lap) {
          lap = await tx.insert(laps).values({
            sessionId, lapNumber: manifest.lap.lapIndex, lapTime: manifest.lap.totalTimeMs / 1000, isValid: true,
            invalidReason: manifest.lap.invalidReason, sectorTimes: manifest.lap.sectorTimesMs.map((time) => time / 1000),
            totalTimeMs: manifest.lap.totalTimeMs, sectorTimesMs: manifest.lap.sectorTimesMs,
            rawByteOffset: admission.rawByteOffset, rawFrameCount: admission.rawFrameCount,
            recordedAt: manifest.lap.recordedAt, createdAt: manifest.lap.setAt,
            sourceClockDomain: provenance?.sourceClock?.domain ?? null,
            sourceLapStartMs: provenance?.sourceClock?.startMs ?? null,
            sourceLapEndMs: provenance?.sourceClock?.endMs ?? null,
            driverAttribution: sourceAttribution,
            driverAttributionStints: provenance?.driverAttributionStints ?? null,
          }).returning({ id: laps.id }).get();
        }
        const currentIdentity = await tx.select({ lapGuid: laps.lapGuid }).from(laps).where(eq(laps.id, lap.id)).get();
        const priorMapping = await tx.select().from(lapGuidReconciliation).where(eq(lapGuidReconciliation.lapId, lap.id)).get();
        const duplicate = await tx.select({ id: laps.id }).from(laps).where(eq(laps.lapGuid, originalGuid)).get();
        if ((currentIdentity?.lapGuid && currentIdentity.lapGuid !== originalGuid)
          || (priorMapping?.sourceGuid && priorMapping.sourceGuid !== originalGuid)
          || (duplicate && duplicate.id !== lap.id)) throw new CloudLapImportError("lap_identity_conflict", false);
        const retainedIdentity = await tx.select().from(originalActivitySourceLaps).where(eq(originalActivitySourceLaps.lapGuid, originalGuid)).get();
        if (retainedIdentity && retainedIdentity.ownerUserId !== manifest.author.userId) throw new CloudLapImportError("lap_owner_conflict", false);
        if ((retainedIdentity?.originalActivityId != null && provenance?.originalActivityId != null && retainedIdentity.originalActivityId !== provenance.originalActivityId)
          || (retainedIdentity?.sourceRevision != null && provenance?.sourceRevision != null && retainedIdentity.sourceRevision !== provenance.sourceRevision)) throw new CloudLapImportError("lap_identity_conflict", false);
        if (!input.isAuthorized()) throw new CloudLapImportError("auth_required", true);
        if (!retainedIdentity) await tx.insert(originalActivitySourceLaps).values({
          lapGuid: originalGuid, originalActivityId: provenance?.originalActivityId ?? null, ownerUserId: manifest.author.userId,
          sourceRevision: provenance?.sourceRevision ?? null,
        }).run();
        else {
          await tx.update(originalActivitySourceLaps).set({
            originalActivityId: retainedIdentity.originalActivityId ?? provenance?.originalActivityId ?? null,
            sourceRevision: retainedIdentity.sourceRevision ?? provenance?.sourceRevision ?? null,
          })
            .where(eq(originalActivitySourceLaps.lapGuid, originalGuid)).run();
        }
        await tx.update(laps).set({
          lapGuid: originalGuid,
          ...(provenance?.sourceClock ? { sourceClockDomain: provenance.sourceClock.domain, sourceLapStartMs: provenance.sourceClock.startMs, sourceLapEndMs: provenance.sourceClock.endMs } : {}),
          ...(provenance?.driverAttributionStints ? { driverAttributionStints: provenance.driverAttributionStints, driverAttribution: sourceAttribution } : {}),
        }).where(eq(laps.id, lap.id)).run();
        await tx.insert(lapGuidReconciliation).values({ lapId: lap.id, lapGuid: originalGuid, sourceGuid: originalGuid, status: "resolved" })
          .onConflictDoUpdate({ target: lapGuidReconciliation.lapId, set: { lapGuid: originalGuid, sourceGuid: originalGuid, status: "resolved" } }).run();
        await rename(temp, final);
        if (setupTemp && setupFinal) await rename(setupTemp, setupFinal);
        result = { id: lap.id, gameId, sessionId };
        if (!input.isAuthorized()) throw new CloudLapImportError("auth_required", true);
      });
      return result;
    });
    committed = true;
    await rm(journalPath, { force: true }).catch(() => {});
    return registered;
  } catch (error) {
    if (!committed) {
      await rm(temp, { force: true });
      await rm(final, { force: true });
      if (setupTemp) await rm(setupTemp, { force: true });
      if (setupFinal) await rm(setupFinal, { force: true });
      await rm(journalTemp, { force: true });
      await rm(journalPath, { force: true });
    }
    if (error instanceof CloudLapImportError) throw error;
    throw new CloudLapImportError("registration_failed", true);
  }
}
