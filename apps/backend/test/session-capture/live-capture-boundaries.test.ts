import { afterAll, expect, test } from "bun:test";
import { open, stat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, liveCaptures } from "@raceiq/backend-core/db/schema";
import {
  beginLiveCapture,
  bindLiveCaptureSourceIdentity,
  commitLiveCaptureMember,
  getLiveLapCaptureSnapshot,
  persistLiveCaptureProgress,
  setLiveCaptureStatus,
} from "@raceiq/backend-core/db/live-capture-queries";
import type { LiveArchiveMember } from "@raceiq/capture-splitting";

const root = await mkdtemp(join(tmpdir(), "raceiq-live-capture-boundaries-"));
const sessionIds: number[] = [];
afterAll(async () => {
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id)).run();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const sourcePath = join(root, `source-${randomUUID()}.bin`);
  const archivePath = join(root, `archive-${randomUUID()}.bin.gz`);
  await writeFile(sourcePath, Buffer.alloc(64, 7));
  const session = await db.insert(sessions).values({ carId: "test-car", trackId: "test-track", gameId: "fm-2023", rawFile: sourcePath })
    .returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const identity = { sessionId: session.id, captureEpoch: randomUUID(), attempt: randomUUID() };
  await beginLiveCapture({ ...identity, sourcePath, archivePath });
  return { identity, sourcePath, archivePath };
}

function auxiliaryMember(): LiveArchiveMember {
  return {
    id: "aux-prefix", kind: "auxiliary", entryName: "aux-prefix.bin.gz", memberOffset: 0,
    compressedByteLength: 8, byteLength: 64, firstOrdinal: 0, recordCount: 1,
    sourceStart: 0, sourceEnd: 1, sourceByteStart: 0, sourceByteEnd: 64, generation: 1,
  };
}

test("live DB publication is fenced by source durability, attempt identity, and archive generation", async () => {
  const { identity, sourcePath, archivePath } = await fixture();
  const sourceInfo = await stat(sourcePath, { bigint: true });
  const staleIdentity = { ...identity, attempt: randomUUID() };
  expect(await bindLiveCaptureSourceIdentity(staleIdentity, String(sourceInfo.dev), String(sourceInfo.ino))).toBe(false);
  expect(await bindLiveCaptureSourceIdentity(identity, String(sourceInfo.dev), String(sourceInfo.ino))).toBe(true);

  const member = auxiliaryMember();
  const verification = { nativeDigest: "a".repeat(64), parserReplayVerified: false };
  expect(await commitLiveCaptureMember({
    identity, priorGeneration: 0, member, verification, ownershipRevision: 0,
  })).toBe(false);

  const staleProgress = await persistLiveCaptureProgress(staleIdentity, {
    sequence: 1, sourceByteLength: 64, sourceRecordCount: 1, sourceDurableWatermark: 64, metadataDurableWatermark: 64,
  }, []);
  expect(staleProgress).toBe(false);
  expect(await persistLiveCaptureProgress(identity, {
    sequence: 1, sourceByteLength: 64, sourceRecordCount: 1, sourceDurableWatermark: 64, metadataDurableWatermark: 64,
  }, [])).toBe(true);

  const archive = await open(archivePath, "w");
  await archive.write(Buffer.alloc(member.compressedByteLength));
  await archive.sync();
  await archive.close();
  expect(await commitLiveCaptureMember({
    identity, priorGeneration: 0, member, verification, ownershipRevision: 0,
  })).toBe(true);
  expect(await commitLiveCaptureMember({
    identity, priorGeneration: 0, member, verification, ownershipRevision: 0,
  })).toBe(false);
  expect(await db.select({ generation: liveCaptures.generation, archiveLength: liveCaptures.committedArchiveLength })
    .from(liveCaptures).where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get()).toEqual({ generation: 1, archiveLength: 8 });
  expect(await commitLiveCaptureMember({
    identity: staleIdentity, priorGeneration: 1, member: { ...member, generation: 2, memberOffset: 8 }, verification, ownershipRevision: 0,
  })).toBe(false);

  expect(await setLiveCaptureStatus(identity, "finalizing")).toBe(true);
  expect(await persistLiveCaptureProgress(identity, {
    sequence: 2, sourceByteLength: 64, sourceRecordCount: 1, sourceDurableWatermark: 64, metadataDurableWatermark: 64,
  }, [])).toBe(true);
  expect(await getLiveLapCaptureSnapshot(identity.sessionId, 999_999)).toBeNull();
  expect(await setLiveCaptureStatus(identity, "failed", "injected failure")).toBe(true);
  expect(await persistLiveCaptureProgress(identity, {
    sequence: 3, sourceByteLength: 64, sourceRecordCount: 1, sourceDurableWatermark: 64, metadataDurableWatermark: 64,
  }, [])).toBe(false);
});
