import { open, stat } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { liveCaptures } from "../db/schema";
import { withSessionCaptureMaintenanceLock } from "./cleanup";

/** Host-bound replay implementation must be registered before restart recovery can publish catch-up work. */
export type LiveCaptureRecoveryReplay = (captureEpoch: string) => Promise<void>;
let replayUnpublished: LiveCaptureRecoveryReplay | null = null;
// Process-local fencing only. Deployment must ensure one recovery owner per DB; DB status is not a cross-process file lease.
const activeCaptureEpochs = new Map<string, number>();

export function registerActiveLiveCapture(captureEpoch: string): () => void {
  activeCaptureEpochs.set(captureEpoch, (activeCaptureEpochs.get(captureEpoch) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const registrations = activeCaptureEpochs.get(captureEpoch) ?? 0;
    if (registrations <= 1) activeCaptureEpochs.delete(captureEpoch);
    else activeCaptureEpochs.set(captureEpoch, registrations - 1);
  };
}


export function registerLiveCaptureRecoveryReplay(replay: LiveCaptureRecoveryReplay): void {
  replayUnpublished = replay;
}

/** Reconcile physical live files against durable DB watermarks before offline job recovery. */
export async function recoverLiveCaptureStorage(): Promise<void> {
  await withSessionCaptureMaintenanceLock(async () => {
    const captures = await db.select().from(liveCaptures)
      .where(inArray(liveCaptures.status, ["recording", "finalizing", "recovering"])).all();
    for (const capture of captures) {
      if (activeCaptureEpochs.has(capture.captureEpoch)) continue;
      try {
        const source = await stat(capture.sourcePath, { bigint: true });
        const hasSourceIdentity = capture.sourceDevice != null && capture.sourceInode != null;
        if (!source.isFile() || (hasSourceIdentity &&
            (String(source.dev) !== capture.sourceDevice || String(source.ino) !== capture.sourceInode)) ||
            (!hasSourceIdentity && (capture.committedArchiveLength > 0 || capture.sourceDurableWatermark > 0))) {
          throw new Error("Live capture source identity is missing or changed");
        }
        const archiveInfo = await stat(capture.archivePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!archiveInfo && capture.committedArchiveLength > 0) throw new Error("Live archive missing committed prefix");
        if (archiveInfo) {
          if (!archiveInfo.isFile() || archiveInfo.size < BigInt(capture.committedArchiveLength)) {
            throw new Error("Live archive shorter than committed prefix");
          }
          if (archiveInfo.size > BigInt(capture.committedArchiveLength)) {
            if (activeCaptureEpochs.has(capture.captureEpoch)) continue;
            const archive = await open(capture.archivePath, "r+");
            try {
              if (activeCaptureEpochs.has(capture.captureEpoch)) continue;
              await archive.truncate(capture.committedArchiveLength);
              await archive.sync();
            } finally {
              await archive.close();
            }
          }
        }
        if (source.size < BigInt(capture.sourceDurableWatermark)) {
          throw new Error("Live source shorter than durable watermark");
        }
        if (activeCaptureEpochs.has(capture.captureEpoch)) continue;
        if (!replayUnpublished) throw new Error("Live restart replay callback is unavailable");
        await db.update(liveCaptures).set({ status: "recovering", error: "Restart recovery replay in progress" })
          .where(eq(liveCaptures.captureEpoch, capture.captureEpoch)).run();
        if (activeCaptureEpochs.has(capture.captureEpoch)) continue;
        await replayUnpublished(capture.captureEpoch);
      } catch (error) {
        if (activeCaptureEpochs.has(capture.captureEpoch)) continue;
        await db.update(liveCaptures).set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
          .where(eq(liveCaptures.captureEpoch, capture.captureEpoch)).run();
      }
    }
  });
}
