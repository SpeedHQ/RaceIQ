import { describe, expect, test } from "bun:test";
import { drainOutbox } from "../../../integrations/raceiq-online/outbox";
import {
  claimNextOutboxJob,
  countOutboxJobs,
  enqueueOutboxJob,
} from "../../../db/online-outbox-storage";
import { prepareUploadPayload } from "../../../integrations/raceiq-online/payload";
import { selectFastestEligibleLaps } from "../../../integrations/raceiq-online/selection";

const identity = (): { accountId: string; accountEpoch: string } => ({
  accountId: `account-${crypto.randomUUID()}`,
  accountEpoch: `epoch-${crypto.randomUUID()}`,
});
const candidate = (
  key: { accountId: string; accountEpoch: string },
  gameId = "acc",
  trackId = `track-${crypto.randomUUID()}`,
) => ({
  ...key,
  gameId,
  trackId,
  carId: "car-a",
  lapId: 1,
  lapTimeMs: 90_000,
  eligibility: {
    status: "eligible" as const,
    authority: "raceiq-online-canonical" as const,
    proofId: `fixture-${crypto.randomUUID()}`,
  },
});

describe("RaceIQ Online outbox safety", () => {
  test("selects only proved fastest candidates and rejects unknown eligibility", () => {
    const proof = { status: "eligible" as const, authority: "raceiq-online-canonical" as const, proofId: "test-proof" };
    const selected = selectFastestEligibleLaps([
      { lapId: 1, lapTimeMs: 95_000, gameId: "acc", trackId: "track-a", carId: "car-a", valid: true, eligibility: proof },
      { lapId: 2, lapTimeMs: 90_000, gameId: "acc", trackId: "track-a", carId: "car-b", valid: true, eligibility: proof },
      { lapId: 3, lapTimeMs: 80_000, gameId: "acc", trackId: "track-b", carId: "car-a", valid: true },
    ]);
    expect(selected.selected.map((lap) => lap.lapId)).toEqual([2]);
    expect(selected.rejected).toEqual([{ lapId: 3, reason: "unknown_eligibility" }]);
  });

  test("coalesces pending work to fastest lap per game and track", async () => {
    const first = candidate(identity());
    expect(await enqueueOutboxJob({ ...first, lapTimeMs: 96_000 })).toBe("queued");
    expect(await enqueueOutboxJob({ ...first, carId: "car-b", lapId: 2, lapTimeMs: 91_000 })).toBe("coalesced");
    expect(await enqueueOutboxJob({ ...first, lapId: 3, lapTimeMs: 93_000 })).toBe("unchanged");

    const claimed = await claimNextOutboxJob({ accountId: first.accountId, accountEpoch: first.accountEpoch });
    expect(claimed).toMatchObject({ lapId: 2, lapTimeMs: 91_000, carId: "car-b", status: "dispatching" });
  });

  test("does not send for another account or epoch", async () => {
    const owner = candidate(identity());
    await enqueueOutboxJob(owner);
    let sends = 0;
    for (const scope of [
      { accountId: owner.accountId, accountEpoch: `${owner.accountEpoch}-wrong` },
      { accountId: `other-${owner.accountId}`, accountEpoch: owner.accountEpoch },
    ]) {
      const result = await drainOutbox({
        ...scope,
        dispatch: async () => { sends++; return { kind: "request_accepted" }; },
        dispatchUnderPrivacyBarrier: async (_job, send) => ({ authorized: true, outcome: await send() }),
      });
      expect(result.attempted).toBe(0);
    }
    expect(sends).toBe(0);
    expect((await countOutboxJobs(owner.accountId, owner.accountEpoch)).queued).toBe(1);
  });

  test("final privacy barrier prevents private dispatch", async () => {
    const job = candidate(identity());
    await enqueueOutboxJob(job);
    let sends = 0;
    const result = await drainOutbox({
      accountId: job.accountId,
      accountEpoch: job.accountEpoch,
      dispatch: async () => { sends++; return { kind: "request_accepted" }; },
      dispatchUnderPrivacyBarrier: async () => ({ authorized: false }),
    });
    expect(sends).toBe(0);
    expect(result.transmitted).toBe(0);
    expect((await countOutboxJobs(job.accountId, job.accountEpoch)).withdrawn).toBe(1);
  });

  test("ambiguous send is retained and never retried", async () => {
    const job = candidate(identity());
    await enqueueOutboxJob(job);
    let sends = 0;
    const drain = () => drainOutbox({
      accountId: job.accountId,
      accountEpoch: job.accountEpoch,
      dispatch: async () => { sends++; return { kind: "ambiguous", code: "transport_lost" }; },
      dispatchUnderPrivacyBarrier: async (_job, send) => ({ authorized: true, outcome: await send() }),
    });
    await drain();
    await drain();
    expect(sends).toBe(1);
    expect((await countOutboxJobs(job.accountId, job.accountEpoch)).ambiguous).toBe(1);
  });

  test("F1 without verified sanitizer fails closed and preserves source bytes", () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const before = new Uint8Array(original);
    const result = prepareUploadPayload({
      gameId: "f1-2025",
      recording: original,
      filename: "lap.bin",
      setupAttachment: null,
      setupUploadsAllowed: false,
      codec: null,
    });
    expect(result).toEqual({ ok: false, reason: "f1_sanitization_failed" });
    expect(original).toEqual(before);
  });

  test("transmitted track is not replayed across account epochs without replay semantics", async () => {
    const original = candidate(identity());
    await enqueueOutboxJob(original);
    await drainOutbox({
      accountId: original.accountId,
      accountEpoch: original.accountEpoch,
      dispatch: async () => ({ kind: "request_accepted" }),
      dispatchUnderPrivacyBarrier: async (_job, send) => ({ authorized: true, outcome: await send() }),
    });
    expect(await enqueueOutboxJob({ ...original, accountEpoch: `new-${crypto.randomUUID()}` })).toBe("unchanged");
    expect(await enqueueOutboxJob({
      ...original,
      accountEpoch: `newer-${crypto.randomUUID()}`,
      lapId: 2,
      lapTimeMs: original.lapTimeMs - 1_000,
    })).toBe("queued");
  });
});
