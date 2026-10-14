import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { api, createRaceIqClient } from "@speedhq/live-client";
import { unzipBounded, type ZipExtractionLimits } from "../archive/bounded-unzip";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { resolveDataDir } from "../runtime/config/data-dir";
import { validateCloudImportCapture } from "./cloud-import-admission";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import type { CloudLapImportStatus } from "@raceiq/shared/integrations/cloud-lap-import";
import type { GameId } from "@raceiq/shared/games/ids";

const MiB = 1024 * 1024;
const MAX_ZIP_BYTES = 512 * MiB;
const MAX_CAPTURE_BYTES = 512 * MiB;
const LIMITS: ZipExtractionLimits = { maxArchiveBytes: MAX_ZIP_BYTES, maxEntries: 3, maxEntryBytes: MAX_CAPTURE_BYTES, maxTotalBytes: MAX_CAPTURE_BYTES + 2 * MiB, strictEntryNames: true };
const utcDatetime = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  author: z.object({ userId: z.string().min(1), displayName: z.string().min(1) }).strict(),
  lap: z.object({
    id: z.string().min(1), gameId: z.enum(["acc", "ac-evo", "f1-2025", "fm-2023", "iracing", "lmu"]), trackId: z.string().min(1), carId: z.string().min(1),
    totalTimeMs: z.number().int().positive().safe(), sectorTimesMs: z.array(z.number().int().positive().safe()).min(1).max(64), complete: z.literal(true), valid: z.literal(true), invalidReason: z.string().nullable(),
    recordedAt: utcDatetime.nullable(), setAt: utcDatetime, lapIndex: z.number().int().nonnegative().safe(), sessionKey: z.number().int().nonnegative().safe(), sessionUID: z.string().nullable(), sourceLapIndex: z.number().int().nonnegative().safe(), sourceSessionKey: z.number().int().nonnegative().safe(),
  }).strict(),
  recording: z.object({ path: z.literal("recording.bin"), format: z.literal("raceiq-session"), frameVersion: z.literal("1"), compression: z.literal("gzip"), sizeBytes: z.number().int().positive().safe() }).strict(),
  processing: z.object({ lapDetectorVersion: z.string().min(1), sourceFrameFormat: z.string().min(1), sourceFrameVersion: z.string().nullable() }).strict(),
  setup: z.object({ path: z.string().regex(/^setup\/[^/\\]+$/), fileName: z.string().min(1), sizeBytes: z.number().int().positive().max(MiB) }).strict().nullable(),
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

const active = new Map<string, Promise<{ id: number; gameId: string; sessionId: number }>>();
const ORIGIN = "https://raceiq.snazzie.space";

export interface CloudLapImportOptions {
  /** Test-only origin override; production calls must use the fixed HTTPS origin. */
  origin?: string;
  fetch?: typeof globalThis.fetch;
}

export function createCloudLapImporter(options: CloudLapImportOptions = {}) {
  const origin = options.origin === undefined ? ORIGIN : validateImportOrigin(options.origin);
  return (input: {
    lapId: string;
    sourceUrl?: string | null;
    accessToken: string;
    onState(status: Exclude<CloudLapImportStatus, "idle" | "awaiting_sign_in" | "complete" | "error">): void;
  }) => importCloudLapWithOptions(input, origin, options.fetch);
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

export function importCloudLap(input: {
  lapId: string;
  sourceUrl?: string | null;
  accessToken: string;
  onState(status: Exclude<CloudLapImportStatus, "idle" | "awaiting_sign_in" | "complete" | "error">): void;
}): Promise<{ id: number; gameId: string; sessionId: number }> {
  return importCloudLapWithOptions(input, ORIGIN);
}

async function importCloudLapWithOptions(input: Parameters<typeof importCloudLap>[0], origin: string, fetcher?: typeof globalThis.fetch): Promise<{ id: number; gameId: string; sessionId: number }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.lapId)) throw new CloudLapImportError("invalid_url", false);
  const requestedId = input.sourceUrl ? validateCloudLapImportUrlAtOrigin(input.sourceUrl, origin) : input.lapId;
  if (requestedId !== input.lapId) throw new CloudLapImportError("lap_id_mismatch", false);
  await recoverCloudLapImports();
  const key = `${origin}\0${input.lapId}`;
  const found = await db.select({ id: laps.id, gameId: sessions.gameId, sessionId: sessions.id })
    .from(sessions).innerJoin(laps, eq(laps.sessionId, sessions.id))
    .where(and(eq(sessions.cloudImportOrigin, origin), eq(sessions.cloudImportLapId, input.lapId))).get();
  if (found) return found;
  const joined = active.get(key);
  if (joined) return joined;
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

let recoveredDataDir: string | null = null;

/** Recover interrupted cloud publication once before accepting imports in this data directory. */
export async function recoverCloudLapImports(): Promise<void> {
  const root = resolveDataDir();
  if (recoveredDataDir === root) return;
  await withSessionCaptureMaintenanceLock(async () => {
    if (recoveredDataDir === root) return;
    await recoverCloudImportJournals();
    recoveredDataDir = root;
  });
}

async function recoverCloudImportJournals(): Promise<void> {
  const root = resolveDataDir();
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
      const dir = join(root, "sessions", journal.gameId);
      const owned = (path: string, pattern: RegExp) => dirname(path) === dir && pattern.test(basename(path));
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

async function performImport(input: Parameters<typeof importCloudLap>[0], origin: string, fetcher?: typeof globalThis.fetch): Promise<{ id: number; gameId: string; sessionId: number }> {
  const { apiClient } = createRaceIqClient({ baseUrl: origin, ...(fetcher ? { fetch: fetcher } : {}) });
  let download;
  try {
    download = await api.downloadLapImport({ client: apiClient, path: { lapId: input.lapId }, headers: { Authorization: `Bearer ${input.accessToken}` }, redirect: "error", parseAs: "stream", signal: AbortSignal.timeout(30_000) });
  } catch { throw new CloudLapImportError("download_failed", true); }
  if (download.response.status === 401) throw new CloudLapImportError("auth_required", true);
  if (download.response.status === 404) throw new CloudLapImportError("recording_unavailable", false);
  if (!download.response.ok || !download.response.body) throw new CloudLapImportError("download_failed", true);
  const archivePath = join(resolveDataDir(), `.cloud-${randomUUID()}.zip.part`);
  await mkdir(resolveDataDir(), { recursive: true });
  const archive = await open(archivePath, "wx", 0o600);
  let length = 0;
  let streamFailure: unknown;
  const reader = download.response.body.getReader();
  let streamComplete = false;
  try {
    for (;;) {
      const next = await reader.read();
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
    if (streamFailure instanceof CloudLapImportError) throw streamFailure;
    throw new CloudLapImportError("download_failed", true);
  }
  input.onState("validating");
  let zip: Buffer;
  try { zip = await readFile(archivePath); } finally { await rm(archivePath, { force: true }); }
  let files: Record<string, Uint8Array>;
  try { files = unzipBounded(zip, LIMITS); } catch { throw new CloudLapImportError("invalid_archive", false); }
  const names = Object.keys(files).sort();
  if (names.some((name) => name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === ".." || part === ".")) || !names.includes("manifest.json") || !names.includes("recording.bin") || names.some((name) => name !== "manifest.json" && name !== "recording.bin" && name !== "setup/opaque" && !name.startsWith("setup/"))) throw new CloudLapImportError("invalid_archive", false);
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = manifestSchema.parse(JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8"))); } catch { throw new CloudLapImportError("invalid_manifest", false); }
  if (manifest.lap.id !== input.lapId) throw new CloudLapImportError("lap_id_mismatch", false);
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
  const directory = join(resolveDataDir(), "sessions", gameId);
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
      let result!: { id: number; gameId: string; sessionId: number };
      await db.transaction(async (tx) => {
        const session = await tx.insert(sessions).values({
          carId: manifest.lap.carId, trackId: manifest.lap.trackId, gameId, sessionType: "cloud-import", rawFile: final,
          lapDetectorVersion: manifest.processing.lapDetectorVersion, source: "cloud-import", ownership: "others",
          sourceAuthorUserId: manifest.author.userId, sourceAuthorDisplayName: manifest.author.displayName,
          cloudImportOrigin: origin, cloudImportLapId: manifest.lap.id,
          cloudImportSessionKey: manifest.lap.sessionKey, cloudImportSessionUid: manifest.lap.sessionUID,
          cloudImportSourceLapIndex: manifest.lap.sourceLapIndex, cloudImportSourceSessionKey: manifest.lap.sourceSessionKey,
          sourceFrameFormat: manifest.processing.sourceFrameFormat, sourceFrameVersion: manifest.processing.sourceFrameVersion,
          cloudImportSetupPath: setupFinal,
          cloudImportSetupFileName: manifest.setup?.fileName ?? null,
          captureFormatVersion: 1,
        }).returning({ id: sessions.id }).get();
        const lap = await tx.insert(laps).values({
          sessionId: session.id, lapNumber: manifest.lap.lapIndex, lapTime: manifest.lap.totalTimeMs / 1000, isValid: true,
          invalidReason: manifest.lap.invalidReason, sectorTimes: manifest.lap.sectorTimesMs.map((time) => time / 1000), totalTimeMs: manifest.lap.totalTimeMs, sectorTimesMs: manifest.lap.sectorTimesMs,
          rawByteOffset: admission.rawByteOffset, rawFrameCount: admission.rawFrameCount, recordedAt: manifest.lap.recordedAt, createdAt: manifest.lap.setAt,
        }).returning({ id: laps.id }).get();
        await rename(temp, final);
        if (setupTemp && setupFinal) await rename(setupTemp, setupFinal);
        result = { id: lap.id, gameId, sessionId: session.id };
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
