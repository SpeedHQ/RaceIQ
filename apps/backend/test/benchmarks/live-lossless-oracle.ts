import { link, mkdir, rm } from "node:fs/promises";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { GameId } from "@raceiq/shared/games/ids";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { getLiveLapCaptureSnapshot } from "@raceiq/backend-core/db/live-capture-queries";
import { openLiveCaptureMember } from "@raceiq/capture-splitting";
import { SESSION_SEGMENT_BOUNDARY, SESSION_SEGMENT_CONTEXT, SESSION_SEGMENT_CONTEXT_END,
  iterateSessionCaptureRecordsAsync } from "@raceiq/capture-formats/session/framing";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { NativeRecordDigest } from "./live-lossless-metrics";

/** Virtual coordinate recorder over an owned hard link; no source re-encoding. */
class OracleSourceRecorder extends SparseSessionRecorderAdapter {
  private running = false;
  private sourceEpoch = 0;
  private nativeCount = 0;
  private position = 0;
  private recordEnd = 0;
  private readonly virtualPath: string;
  constructor(path: string) { super("others", {}, "offline"); this.virtualPath = path; }
  setRecord(offset: number, endOffset: number): void { this.position = offset; this.recordEnd = endOffset; }
  override get active(): boolean { return this.running; }
  override get path(): string | null { return this.running ? this.virtualPath : null; }
  override get epoch(): number { return this.sourceEpoch; }
  override get sourceOrdinal(): number | undefined { return this.nativeCount ? this.nativeCount - 1 : undefined; }
  override start(_gameId: GameId): void { this.running = true; this.nativeCount = 0; this.sourceEpoch++; }
  override writeRecord(_frame: Buffer, _timestamp?: number): void { this.nativeCount++; this.position = this.recordEnd; }
  // Prefix bytes already exist in the original source; virtual writes must not insert them again.
  override writeMetaFrame(): void {}
  override writeRawCaptureBytes(_bytes: Buffer): void {}
  override writeSegmentBoundary(): void {}
  override getCurrentByteOffset(): number { return this.position; }
  override async stop(): Promise<void> { this.running = false; }
}

const fields = { id: laps.id, lapNumber: laps.lapNumber, lapTime: laps.lapTime, isValid: laps.isValid,
  invalidReason: laps.invalidReason, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount };
async function* ownedLaps(sessionId: number | undefined) {
  if (sessionId === undefined) return;
  let lastOffset: number | undefined, lastId = 0;
  while (true) {
    const after = lastOffset === undefined ? undefined : or(gt(laps.rawByteOffset, lastOffset),
      and(eq(laps.rawByteOffset, lastOffset), gt(laps.id, lastId)));
    const page = await db.select(fields).from(laps).where(and(eq(laps.sessionId, sessionId), after))
      .orderBy(asc(laps.rawByteOffset), asc(laps.id)).limit(128).all();
    if (!page.length) return;
    for (const lap of page) {
      if (lap.rawByteOffset === null || lap.rawFrameCount === null || lap.rawFrameCount <= 0) throw new Error("Offline oracle encountered a lap without a native source window");
      yield { ...lap, rawByteOffset: lap.rawByteOffset, rawFrameCount: lap.rawFrameCount };
      lastOffset = lap.rawByteOffset; lastId = lap.id;
    }
  }
}

/** Independent detector over retained canonical records; never receives live ownership windows or candidate checkpoints. */
export async function verifyLiveCaptureAgainstOffline({ sessionId, outputDirectory }: { sessionId: number; outputDirectory: string }): Promise<{ comparedLapCount: number; comparedNativeRecordCount: number }> {
  const row = await db.select({ rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId,
    carId: sessions.carId, trackId: sessions.trackId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row?.rawFile) throw new Error(`Live session ${sessionId} has no retained canonical source`);
  const source = { ...row, rawFile: row.rawFile, gameId: row.gameId as GameId };
  const recorder = new OracleSourceRecorder(`${outputDirectory}/oracle-virtual-${sessionId}.bin`);
  await mkdir(outputDirectory, { recursive: true });
  const aliasPath = `${outputDirectory}/oracle-virtual-${sessionId}.bin`;
  await link(source.rawFile, aliasPath);
  async function* frames() {
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      recorder.setRecord(record.offset, record.endOffset);
      if (record.kind === "frame") yield { frame: record.frame, frameTimeMs: record.frameTimeMs };
      else if (record.kind === "segment-boundary") yield SESSION_SEGMENT_BOUNDARY;
      else if (record.kind === "segment-context") yield SESSION_SEGMENT_CONTEXT;
      else if (record.kind === "segment-context-end") yield SESSION_SEGMENT_CONTEXT_END;
      else yield record;
    }
  }
  const imported = await importSessionFrames(frames(), source.gameId, { requireLaps: false, notifyDriverProfile: false, ownership: "others", recorder });
  try {
    async function* pairs() {
      const actual = ownedLaps(sessionId), expected = ownedLaps(imported.sessionIds[0]);
      while (true) {
        const [a, e] = await Promise.all([actual.next(), expected.next()]);
        if (a.done || e.done) {
          if (a.done !== e.done) throw new Error("Independent offline detector lap count differs from live detector");
          return;
        }
        if (a.value.lapNumber !== e.value.lapNumber || a.value.lapTime !== e.value.lapTime || a.value.isValid !== e.value.isValid ||
            a.value.invalidReason !== e.value.invalidReason || a.value.rawByteOffset !== e.value.rawByteOffset || a.value.rawFrameCount !== e.value.rawFrameCount) {
          throw new Error(`Independent offline detector ownership/timing/validity mismatch at lap ${a.value.lapNumber}`);
        }
        const capture = await getLiveLapCaptureSnapshot(sessionId, a.value.id);
        if (!capture || capture.snapshot.member.ownedFrameCount !== e.value.rawFrameCount) throw new Error("Independent owned frame count differs from published lap");
        yield { expected: e.value, capture, trailing: capture.snapshot.member.trailingContextFrameCount ?? 0 };
      }
    }
    const windows = pairs();
    let current = await windows.next();
    let digest = new NativeRecordDigest();
    let comparedLapCount = 0, comparedNativeRecordCount = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      if (record.kind !== "frame") continue;
      while (!current.done && record.offset >= current.value.expected.rawByteOffset) {
        const window = current.value;
        if (digest.count === 0 && record.offset !== window.expected.rawByteOffset) throw new Error("Independent owned window is not native-frame aligned");
        digest.add(record.frame, record.frameTimeMs);
        if (digest.count < window.expected.rawFrameCount + window.trailing) break;
        const actual = new NativeRecordDigest();
        const { archivePath, snapshot } = window.capture;
        const archive = await openLiveCaptureMember(archivePath, snapshot);
        for await (const derived of iterateSessionCaptureRecordsAsync(archive.readEntry(snapshot.member.entryName), { strict: true })) {
          if (derived.kind === "frame") actual.add(derived.frame, derived.frameTimeMs);
        }
        if (actual.count !== digest.count || actual.digest() !== digest.digest()) throw new Error("Published lap changed independent native bytes/order/acquisition timestamp presence");
        comparedLapCount++; comparedNativeRecordCount += window.expected.rawFrameCount;
        current = await windows.next();
        digest = new NativeRecordDigest();
        // A single normalization-context frame may also begin the following owned window.
        if (!current.done && (current.value.expected.rawByteOffset < record.offset ||
            (window.trailing === 0 && current.value.expected.rawByteOffset === record.offset))) throw new Error("Independent owned windows overlap beyond normalization context");
      }
      if (current.done) break;
    }
    if (!current.done) throw new Error("Canonical source ended inside an independently detected owned window");
    return { comparedLapCount, comparedNativeRecordCount };
  } finally {
    for (const id of imported.sessionIds) await deleteSession(id);
    await rm(aliasPath, { force: true });
  }
}
