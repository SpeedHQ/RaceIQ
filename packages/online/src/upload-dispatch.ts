import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { resolveOnlineDataDir } from "./runtime";
import { clearRetiredOutboxPayloads, listRetiredOutboxPayloads, persistOutboxPayload, saveOutboxReservation, type OutboxJob } from "./outbox-storage";
import { OnlineAdapterError, type createRaceIqOnlineAdapter } from "./adapter";
import { UPLOAD_GAME_IDS, uploadPayloadFingerprint, type PreparedOnlineLapUpload, type UploadGame } from "./payload";
import type { UploadOutcome } from "./outbox";

export interface OnlineUploadContext { accountId: string; accountEpoch: string; revision: number; setupUploads: boolean }
type Adapter = ReturnType<typeof createRaceIqOnlineAdapter>;
export interface OnlineUploadDispatchPort {
  getContext(): Promise<OnlineUploadContext | null>;
  isAuthorized(context: OnlineUploadContext, includesSetup: boolean): boolean;
  reserveLapUpload: Adapter["reserveLapUpload"];
  uploadLap: Adapter["uploadLap"];
  prepareRecording(lapId: number, setupUploads: boolean): Promise<PreparedOnlineLapUpload>;
}
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
function artifactRoot(): string { return join(resolveOnlineDataDir(), "online-upload-payloads"); }
function ownedPath(path: string): string {
  const normalized = resolve(path);
  if (!normalized.startsWith(`${resolve(artifactRoot())}${sep}`)) throw new Error("Online payload path is outside managed storage");
  return normalized;
}
async function publish(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function load(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = Bun.file(ownedPath(path));
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) throw new Error("Online payload size is invalid");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Online payload size is invalid");
  return bytes;
}
/** Terminal artifacts are disposable; acceptance/history timestamps remain immutable. */
export async function cleanupRetiredOnlinePayloads(): Promise<void> {
  for (const row of await listRetiredOutboxPayloads()) {
    if (row.recordingPath) await rm(ownedPath(row.recordingPath), { force: true });
    if (row.setupPath) await rm(ownedPath(row.setupPath), { force: true });
    await clearRetiredOutboxPayloads(row.rowId);
  }
}

const keepRunning = () => true;
export function createOnlineUploadDispatcher(port: OnlineUploadDispatchPort): (job: OutboxJob, mayStart?: () => boolean) => Promise<UploadOutcome> {
  return async (initial, mayStart = keepRunning) => {
    let phase: "prepare" | "reserve" | "upload" = "prepare";
    let job = initial;
    const cancelled = (): UploadOutcome => mayStart() ? { kind: "withdrawn" } : { kind: "definitely_not_sent", code: "service_unavailable", retryable: true, retryAfterMs: 0 };
    if (!mayStart()) return cancelled();
    const context = await port.getContext();
    if (!context || context.accountId !== job.accountId || context.accountEpoch !== job.accountEpoch) return { kind: "withdrawn" };
    if (!UPLOAD_GAME_IDS.includes(job.gameId as UploadGame) || !job.uploadKey) return { kind: "rejected", code: "unsupported_game" };
    const gameId = job.gameId as UploadGame;
    const authorized = (includesSetup = false) => mayStart() && port.isAuthorized(context, includesSetup);
    try {
      let reconciledToken: string | undefined;
      if (job.payloadFingerprint && job.recordingPath) {
        // Reconcile this exact durable identity before replacing bytes after a restriction/reprocess.
        phase = "reserve";
        const reservation = await port.reserveLapUpload({ gameId, idempotencyKey: job.uploadKey, consentAccepted: true, visibility: "public", isAuthorized: () => authorized() });
        if (reservation.acceptedJobId) return { kind: "request_accepted", remoteJobId: reservation.acceptedJobId };
        if (!reservation.reservationToken || !await saveOutboxReservation(job, reservation.reservationToken)) return { kind: "ambiguous", code: "internal_error" };
        reconciledToken = reservation.reservationToken;
      }
      phase = "prepare";
      const prepared = await port.prepareRecording(job.lapId, context.setupUploads);
      if (prepared.lapId !== job.lapId || prepared.gameId !== gameId || prepared.trackId !== job.trackId || prepared.carId !== job.carId || prepared.lapTimeMs !== job.lapTimeMs) return { kind: "rejected", code: "ineligible_lap" };
      if (!authorized(prepared.setup !== null)) return cancelled();
      const directory = join(artifactRoot(), createHash("sha256").update(job.accountId).digest("hex"));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const recordingPath = join(directory, `${job.rowId}-${prepared.fingerprint}.bin`);
      const setupPath = prepared.setup ? join(directory, `${job.rowId}-${prepared.fingerprint}.setup`) : null;
      await publish(recordingPath, prepared.recording);
      if (setupPath && prepared.setup) await publish(setupPath, prepared.setup);
      const stored = await persistOutboxPayload(job, { fingerprint: prepared.fingerprint, recordingPath, setupPath }, reconciledToken);
      if (!stored?.uploadKey) return { kind: "ambiguous", code: "internal_error" };
      if (stored.status !== "dispatching") return { kind: "definitely_not_sent", code: "service_unavailable", retryable: true, retryAfterMs: 0 };
      const uploadKey = stored.uploadKey;
      job = stored;
      // The persisted copy, not a mutable source/session, is the transport's immutable payload.
      const recording = await load(recordingPath);
      const setup = setupPath ? await load(setupPath) : null;
      if (uploadPayloadFingerprint(recording, setup) !== job.payloadFingerprint || !prepared.codec.isServiceCompatible(recording, gameId) || (gameId === "f1-2025" && prepared.codec.hasF1SetupTelemetry(recording))) return { kind: "rejected", code: gameId === "f1-2025" ? "f1_sanitization_failed" : "ineligible_lap" };
      phase = "reserve";
      // A new key after changed bytes needs its own reservation; unchanged reconciled bytes reuse the fresh token.
      let token = reconciledToken && stored.uploadKey === initial.uploadKey ? reconciledToken : undefined;
      if (!token) {
        const reservation = await port.reserveLapUpload({ gameId, idempotencyKey: uploadKey, consentAccepted: true, visibility: "public", isAuthorized: () => authorized() });
        if (reservation.acceptedJobId) return { kind: "request_accepted", remoteJobId: reservation.acceptedJobId };
        if (!reservation.reservationToken || !await saveOutboxReservation(job, reservation.reservationToken)) return { kind: "ambiguous", code: "internal_error" };
        token = reservation.reservationToken;
      }
      if (!authorized(setup !== null)) return cancelled();
      phase = "upload";
      const result = await port.uploadLap({ gameId, filename: prepared.filename, recording, setup: setup ?? undefined, idempotencyKey: uploadKey, reservationToken: token, consentAccepted: true, visibility: "public", setupUploads: context.setupUploads, codec: prepared.codec, isAuthorized: () => authorized(setup !== null) });
      const remoteJobId = "acceptedJobId" in result ? result.acceptedJobId : result.id;
      if (typeof remoteJobId !== "string" || !remoteJobId) return { kind: "ambiguous", code: "internal_error" };
      return { kind: "request_accepted", remoteJobId };
    } catch (cause) {
      if (phase === "prepare" && cause instanceof Error && "code" in cause && cause.code === "service_unavailable" && "retryable" in cause && cause.retryable === true) return { kind: "definitely_not_sent", code: "service_unavailable", retryable: true };
      if (cause instanceof OnlineAdapterError) {
        if (cause.code === "not_connected" && !authorized()) return cancelled();
        const retryAfterMs = cause.retryAfter ? Math.max(0, Date.parse(cause.retryAfter) - Date.now()) : undefined;
        const definitive = phase !== "upload" || (cause.responseStatus !== null && cause.responseStatus >= 400 && cause.responseStatus < 500);
        if (definitive) return { kind: "definitely_not_sent", code: cause.code === "invalid_response" ? "ineligible_lap" : cause.code, retryable: cause.retryable, retryAfterMs };
        return { kind: "ambiguous", code: cause.code };
      }
      return phase === "prepare" ? { kind: "rejected", code: "ineligible_lap" } : { kind: "ambiguous", code: "internal_error" };
    }
  };
}
