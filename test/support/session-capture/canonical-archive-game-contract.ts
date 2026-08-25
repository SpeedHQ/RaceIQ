import { expect } from "bun:test";
import { eq } from "drizzle-orm";

import {
  CANONICAL_ARCHIVE_SCHEMA_VERSION,
  CanonicalArchiveAvailabilitySchema,
} from "../../../shared/racing/archives/contracts";
import type { GameId } from "../../../shared/games/ids";
import { readCanonicalArchiveSamples } from "../../../server/db/canonical-archive-reader";
import {
  claimCanonicalArchiveJob,
  enqueueCanonicalArchiveJob,
} from "../../../server/db/canonical-archive-queries";
import { db } from "../../../server/db/index";
import { canonicalArchives } from "../../../server/db/schema";
import { getSessionCanonicalAvailability } from "../../../server/lap-analysis/canonical-archive-availability";
import { buildCanonicalArchive } from "../../../server/session-capture/canonical-archive";
import { inspectRawCaptureIdentity } from "../../../server/session-capture/identity";

export async function assertCanonicalArchiveGameContract(input: {
  sessionId: number;
  gameId: GameId;
  rawFile: string;
}) {
  const source = await inspectRawCaptureIdentity(input.rawFile);
  if (!source) throw new Error(`Raw capture disappeared: ${input.rawFile}`);

  const job = await enqueueCanonicalArchiveJob({
    sessionId: input.sessionId,
    sourceContentHash: source.contentHash,
  });
  const lease = await claimCanonicalArchiveJob({ jobId: job.jobId, leaseMs: 60_000 });
  if (lease?.jobId !== job.jobId || !lease.leaseToken) {
    throw new Error("Canonical archive build job claim failed");
  }

  const built = await buildCanonicalArchive({
    sessionId: input.sessionId,
    sourceContentHash: source.contentHash,
    jobId: lease.jobId,
    leaseToken: lease.leaseToken,
  });
  const archive = await db.select()
    .from(canonicalArchives)
    .where(eq(canonicalArchives.archiveId, built.archive.archiveId))
    .get();
  if (!archive) throw new Error("Canonical archive row was not activated");

  const receipt = built.receipt.receipt;
  if (!receipt) throw new Error("Canonical archive receipt was not activated");

  expect(archive).toMatchObject({
    sessionId: input.sessionId,
    status: "verified",
    completeness: "complete",
    sourceContentHash: source.contentHash,
    schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
  });
  expect(archive.outputContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(archive.byteSize).toBeGreaterThan(0);
  expect(archive.sourceContentHash).not.toBe(archive.outputContentHash);
  expect(receipt.evidence).toMatchObject({
    kind: "raceiq-raw",
    objectId: `session:${input.sessionId}:raw-capture`,
    contentHash: source.contentHash,
    byteSize: source.byteSize,
    formatVersion: "raceiq-session-framing-v1",
  });
  expect(receipt.outputs).toContainEqual(expect.objectContaining({
    artifactType: "canonical_archive",
    contentHash: archive.outputContentHash,
    schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
  }));

  const availability = CanonicalArchiveAvailabilitySchema.parse(
    await getSessionCanonicalAvailability(input.sessionId),
  );
  expect(availability).toMatchObject({
    state: "available",
    archiveId: archive.archiveId,
    generationId: archive.generationId,
  });

  const samples = await readCanonicalArchiveSamples(archive.archivePath);
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(JSON.parse(sample.packetJson)).toMatchObject({ gameId: input.gameId });
  }

  return { archive, receipt };
}
