import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { processOutboxDelivery } from "../src/outbox";
import {
  beginOutboxAttempt, enqueueOutboxJob, getAccountOutboxStatus, getOutboxJob,
  listDeliverableOutboxJobs, listRetiredOutboxPayloads, persistOutboxPayload,
  recordOutboxAcceptance, saveOutboxReservation, settleOutboxDelivery,
  type EnqueueOutboxJob, type OutboxJob,
} from "../src/outbox-storage";

async function getQueuedJob(input: EnqueueOutboxJob): Promise<OutboxJob> {
  await enqueueOutboxJob(input);
  const [job] = await listDeliverableOutboxJobs(input.accountId);
  if (!job) throw new Error("Expected keyed outbox row");
  return job;
}

async function begin(job: OutboxJob, attempts = 1): Promise<OutboxJob> {
  const started = await beginOutboxAttempt({
    rowId: job.rowId, accountId: job.accountId, accountEpoch: job.accountEpoch,
    uploadKey: job.uploadKey!, attempts,
  });
  if (!started) throw new Error("Expected outbox attempt");
  return started;
}
const identity = () => ({ accountId: `account-${crypto.randomUUID()}`, accountEpoch: `epoch-${crypto.randomUUID()}` });
const candidate = (key: { accountId: string; accountEpoch: string }) => ({
  ...key, gameId: "acc", trackId: `track-${crypto.randomUUID()}`, carId: "car-a", lapId: 1, lapTimeMs: 90_000,
});

describe("RaceIQ Online outbox ledger", () => {
  test("coalesces pending fastest lap per game and track", async () => {
    const job = candidate(identity());
    expect(await enqueueOutboxJob({ ...job, lapTimeMs: 96_000 })).toBe("queued");
    expect(await enqueueOutboxJob({ ...job, lapId: 2, lapTimeMs: 91_000 })).toBe("coalesced");
    expect(await enqueueOutboxJob({ ...job, lapId: 3, lapTimeMs: 93_000 })).toBe("unchanged");
  });
  test("privacy barrier prevents dispatch and permanently withdraws pending intent", async () => {
    const job = candidate(identity());
    await enqueueOutboxJob(job);
    const [row] = await listDeliverableOutboxJobs(job.accountId);
    let sends = 0;
    const result = await processOutboxDelivery({
      reference: { rowId: row.rowId, uploadKey: row.uploadKey! },
      accountId: job.accountId, accountEpoch: job.accountEpoch, attempts: 1, maxAttempts: 5,
      dispatch: async () => { sends++; return { kind: "request_accepted", remoteJobId: "unexpected" }; },
      dispatchUnderPrivacyBarrier: async () => ({ authorized: false }),
    });
    expect(result).toEqual({ kind: "ack" });
    expect(sends).toBe(0);
    expect((await getAccountOutboxStatus(job.accountId)).queued).toBe(0);
  });

  test("accepted UUID is durable and redelivery never dispatches again", async () => {
    const job = candidate(identity());
    await enqueueOutboxJob(job);
    const [row] = await listDeliverableOutboxJobs(job.accountId);
    let sends = 0;
    const process = (attempts: number) => processOutboxDelivery({
      reference: { rowId: row.rowId, uploadKey: row.uploadKey! },
      accountId: job.accountId, accountEpoch: job.accountEpoch, attempts, maxAttempts: 5,
      dispatch: async () => { sends++; return { kind: "request_accepted", remoteJobId: "remote-a" }; },
      dispatchUnderPrivacyBarrier: async (_job, send) => ({ authorized: true, outcome: await send() }),
    });
    expect(await process(1)).toEqual({ kind: "ack" });
    expect(await process(2)).toEqual({ kind: "ack" });
    expect(sends).toBe(1);
    expect((await getAccountOutboxStatus(job.accountId)).lastSyncedAt).not.toBeNull();
  });
  test("ambiguous delivery retries same identity, including final package attempt", async () => {
    const job = candidate(identity());
    await enqueueOutboxJob(job);
    const [row] = await listDeliverableOutboxJobs(job.accountId);
    if (!row.uploadKey) throw new Error("Expected durable request identity");
    const reference = { rowId: row.rowId, uploadKey: row.uploadKey! };
    const dispatchedKeys: string[] = [];
    const deliver = (attempts: number, outcome: "ambiguous" | "request_accepted") => processOutboxDelivery({
      reference, accountId: job.accountId, accountEpoch: job.accountEpoch, attempts, maxAttempts: 5,
      dispatch: async current => {
        dispatchedKeys.push(current.uploadKey!);
        return outcome === "ambiguous" ? { kind: "ambiguous", code: "transport_lost" } :
          { kind: "request_accepted", remoteJobId: "remote-b" };
      },
      dispatchUnderPrivacyBarrier: async (_job, send) => ({ authorized: true, outcome: await send() }),
    });
    expect(await deliver(1, "ambiguous")).toEqual({ kind: "retry" });
    expect(await deliver(5, "ambiguous")).toEqual({ kind: "retry" });
    expect(await deliver(5, "request_accepted")).toEqual({ kind: "ack" });
    expect(dispatchedKeys).toEqual([row.uploadKey, row.uploadKey, row.uploadKey]);
  });

  test("same-key persisted dispatching attempt can recover after lost receipt", async () => {
    const job = candidate(identity());
    await enqueueOutboxJob(job);
    const [row] = await listDeliverableOutboxJobs(job.accountId);
    const input = { rowId: row.rowId, accountId: job.accountId, accountEpoch: job.accountEpoch,
      uploadKey: row.uploadKey!, attempts: 1 };
    expect(await beginOutboxAttempt(input)).toMatchObject({ status: "dispatching", uploadKey: row.uploadKey });
    expect(await beginOutboxAttempt({ ...input, attempts: 2 })).toMatchObject({
      status: "dispatching", uploadKey: row.uploadKey, attempts: 2,
    });
  });

  test("account status is isolated and remains durable", async () => {
    const owner = identity();
    const other = identity();
    await enqueueOutboxJob(candidate(owner));
    await enqueueOutboxJob(candidate(other));
    expect(await getAccountOutboxStatus(owner.accountId)).toMatchObject({
      queued: 1, inFlight: 0, rejected: 0, ambiguous: 0, lastSyncedAt: null,
    });
    expect(await getAccountOutboxStatus(other.accountId)).toMatchObject({ queued: 1 });
  });
  test("rejects stale, wrong-account, and wrong-key acceptance and settlement", async () => {
    const input = candidate(identity());
    const job = await getQueuedJob(input);
    const attempt = await begin(job);
    const wrongKey = { ...attempt, uploadKey: `${attempt.uploadKey}-wrong` };
    const wrongAccount = { ...attempt, accountId: `${attempt.accountId}-wrong` };
    expect(await recordOutboxAcceptance(wrongKey, "remote-wrong")).toBe(false);
    expect(await recordOutboxAcceptance(wrongAccount, "remote-wrong")).toBe(false);
    expect(await settleOutboxDelivery({ job: wrongKey, status: "ambiguous" })).toBe(false);
    expect(await settleOutboxDelivery({ job: wrongAccount, status: "ambiguous" })).toBe(false);
    expect(await settleOutboxDelivery({ job: { ...attempt, accountEpoch: "stale-epoch" }, status: "ambiguous" })).toBe(false);
    expect(await recordOutboxAcceptance(attempt, "remote-correct")).toBe(true);
  });

  test("ambiguous payload replacement requires matching unaccepted reservation token", async () => {
    const input = candidate(identity());
    const queued = await getQueuedJob(input);
    const attempt = await begin(queued);
    const original = await persistOutboxPayload(attempt, {
      fingerprint: "fingerprint-original", recordingPath: "/recording-original", setupPath: null,
    });
    expect(original).not.toBeNull();
    expect(await saveOutboxReservation(original!, "reservation-original")).toBe(true);
    expect(await settleOutboxDelivery({ job: original!, status: "ambiguous" })).toBe(true);
    const ambiguous = await getOutboxJob(original!.rowId, original!.accountId);
    expect(ambiguous).not.toBeNull();
    const replacement = { fingerprint: "fingerprint-replacement", recordingPath: "/recording-replacement", setupPath: null };
    expect(await persistOutboxPayload(ambiguous!, replacement)).toBeNull();
    expect(await persistOutboxPayload(ambiguous!, replacement, "wrong-token")).toBeNull();
    const replaced = await persistOutboxPayload(ambiguous!, replacement, "reservation-original");
    expect(replaced).toMatchObject({ payloadFingerprint: replacement.fingerprint, recordingPath: replacement.recordingPath });
    expect(replaced?.uploadKey).not.toBe(ambiguous!.uploadKey);
  });

  test("rejected lap stays deduplicated while faster distinct lap can queue", async () => {
    const input = candidate(identity());
    const queued = await getQueuedJob(input);
    const attempt = await begin(queued);
    expect(await settleOutboxDelivery({ job: attempt, status: "rejected", errorCode: "validation_rejected" })).toBe(true);
    expect(await enqueueOutboxJob(input)).toBe("unchanged");
    expect(await enqueueOutboxJob({ ...input, lapId: input.lapId + 1, lapTimeMs: input.lapTimeMs - 1_000 })).toBe("queued");
  });

  test("coalescing retires old row without losing managed file references", async () => {
    const input = candidate(identity());
    const queued = await getQueuedJob(input);
    expect(await persistOutboxPayload(queued, {
      fingerprint: `fingerprint-${crypto.randomUUID()}`, recordingPath: `/recording-${crypto.randomUUID()}`,
      setupPath: `/setup-${crypto.randomUUID()}`,
    })).not.toBeNull();
    await enqueueOutboxJob({ ...input, lapId: input.lapId + 1, lapTimeMs: input.lapTimeMs - 1_000 });
    expect(await listRetiredOutboxPayloads()).toContainEqual({
      rowId: queued.rowId, recordingPath: expect.any(String), setupPath: expect.any(String),
    });
  });
  test("terminal history does not consume active capacity and faster replacements fit at the limit", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "raceiq-outbox-capacity-"));
    try {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "outbox-capacity.fixture.ts")], {
        env: { ...process.env, DATA_DIR: dataDir },
      });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      expect(child.stdout.toString()).toContain("active-capacity-history-and-replacement-verified");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("legacy migration backfills accepted timestamp once and never invents key for keyless intent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "raceiq-outbox-migration-"));
    try {
      const fixture = join(import.meta.dir, "outbox-migration.fixture.ts");
      const run = () => {
        const child = Bun.spawnSync([process.execPath, fixture], {
          env: { ...process.env, DATA_DIR: dataDir },
        });
        expect(child.exitCode).toBe(0);
        return JSON.parse(child.stdout.toString()) as {
          rows: { status: string; upload_key: string | null; transmitted_at: number | null }[];
          deliverableCount: number;
          recovered: { uploadKey: string; trackId: string }[];
        };
      };
      const first = run();
      const second = run();
      expect(first.rows[0]).toMatchObject({ status: "transmitted", upload_key: null, transmitted_at: 1234 });
      expect(first.rows[1]).toMatchObject({ status: "ambiguous", upload_key: null, transmitted_at: null });
      expect(first.rows[2]).toMatchObject({ status: "dispatching", upload_key: "same-upload-key" });
      expect(first.rows[3]).toMatchObject({ status: "ambiguous", upload_key: "stranded-upload-key" });
      expect(first.rows[4]).toMatchObject({ status: "ambiguous", upload_key: "uncertain-upload-key" });
      expect(first.rows[5]).toMatchObject({ status: "dispatching", upload_key: "old-cross-epoch-key" });
      expect(first.rows[6]).toMatchObject({ status: "pending", upload_key: "new-cross-epoch-key" });
      expect(second.rows[2]).toMatchObject({ status: "pending", upload_key: "same-upload-key" });
      expect(second.rows[3]).toMatchObject({ status: "pending", upload_key: "stranded-upload-key" });
      expect(second.rows[4]).toMatchObject({ status: "ambiguous", upload_key: "uncertain-upload-key" });
      expect(second.rows[5]).toMatchObject({ status: "withdrawn", upload_key: "old-cross-epoch-key" });
      expect(second.rows[6]).toMatchObject({ status: "pending", upload_key: "new-cross-epoch-key" });
      expect(second.recovered).toEqual([
        { uploadKey: "same-upload-key", trackId: "prepayload-track" },
        { uploadKey: "stranded-upload-key", trackId: "stranded-track" },
        { uploadKey: "new-cross-epoch-key", trackId: "cross-epoch-track" },
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
