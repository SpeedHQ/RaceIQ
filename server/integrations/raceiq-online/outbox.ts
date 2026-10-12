import {
  claimNextOutboxJob,
  countOutboxJobs,
  ensureOutboxStorage,
  settleOutboxJob,
  withdrawUnsentOutboxJobs,
  type OutboxJob,
} from "../../db/online-outbox-storage";

const MAX_DRAIN_JOBS = 5;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

export type UploadOutcome =
  | { readonly kind: "request_accepted" }
  | { readonly kind: "definitely_not_sent"; readonly code: string; readonly retryable: boolean; readonly retryAfterMs?: number }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "ambiguous"; readonly code: string };

export type DispatchResult =
  | { readonly authorized: false }
  | { readonly authorized: true; readonly outcome: UploadOutcome };

/**
 * Integration must check current account, epoch, consent, policy, and public
 * preference under the same serialization barrier as restrictive mutations.
 * Invoke `send` only after that check, immediately before starting transport.
 */
export type DispatchUnderPrivacyBarrier = (
  job: OutboxJob,
  send: () => Promise<UploadOutcome>,
) => Promise<DispatchResult>;

export type DrainResult = {
  readonly attempted: number;
  readonly transmitted: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly queued: number;
  readonly inFlight: number;
};

export type DrainInput = {
  readonly accountId: string;
  readonly accountEpoch: string;
  readonly dispatch: (job: OutboxJob) => Promise<UploadOutcome>;
  readonly dispatchUnderPrivacyBarrier: DispatchUnderPrivacyBarrier;
  readonly maxJobs?: number;
  readonly now?: () => number;
};

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(attempt - 1, 10));
}

function validErrorCode(code: string): string {
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : "internal_error";
}

/** One bounded pass for one account epoch; ambiguous requests are never replayed. */
export async function drainOutbox(input: DrainInput): Promise<DrainResult> {
  const now = input.now ?? Date.now;
  const requestedMax = Number.isFinite(input.maxJobs) ? Math.floor(input.maxJobs!) : MAX_DRAIN_JOBS;
  const maxJobs = Math.min(MAX_DRAIN_JOBS, Math.max(0, requestedMax));
  await ensureOutboxStorage();
  let attempted = 0;
  let transmitted = 0;
  let deferred = 0;
  let rejected = 0;
  let ambiguous = 0;

  while (attempted < maxJobs) {
    const job = await claimNextOutboxJob({ accountId: input.accountId, accountEpoch: input.accountEpoch, now: now() });
    if (!job) break;
    attempted++;
    let sendInvoked = false;
    let result: DispatchResult;
    try {
      result = await input.dispatchUnderPrivacyBarrier(job, async () => {
        if (sendInvoked) return { kind: "ambiguous", code: "internal_error" };
        sendInvoked = true;
        try {
          return await input.dispatch(job);
        } catch {
          return { kind: "ambiguous", code: "internal_error" };
        }
      });
    } catch {
      result = { authorized: true, outcome: { kind: "ambiguous", code: "internal_error" } };
    }
    if (!result.authorized && sendInvoked) {
      result = { authorized: true, outcome: { kind: "ambiguous", code: "internal_error" } };
    } else if (result.authorized && !sendInvoked) {
      result = { authorized: false };
    }
    if (!result.authorized) {
      await settleOutboxJob({ job, status: "withdrawn", errorCode: "dispatch_barrier", now: now() });
      continue;
    }

    const outcome = result.outcome;
    if (outcome.kind === "request_accepted") {
      if (await settleOutboxJob({ job, status: "transmitted", now: now() })) transmitted++;
      else ambiguous++;
    } else if (outcome.kind === "definitely_not_sent" && outcome.retryable && job.attempts < MAX_ATTEMPTS) {
      const delay = Number.isSafeInteger(outcome.retryAfterMs) && Number(outcome.retryAfterMs) >= 0
        ? Math.min(MAX_BACKOFF_MS, Number(outcome.retryAfterMs))
        : backoffMs(job.attempts);
      await settleOutboxJob({ job, status: "pending", nextAttemptAt: now() + delay, errorCode: validErrorCode(outcome.code), now: now() });
      deferred++;
      break;
    } else if (outcome.kind === "definitely_not_sent" || outcome.kind === "rejected") {
      if (await settleOutboxJob({ job, status: "rejected", errorCode: validErrorCode(outcome.code), now: now() })) rejected++;
      else ambiguous++;
    } else {
      if (await settleOutboxJob({ job, status: "ambiguous", errorCode: validErrorCode(outcome.code), now: now() })) ambiguous++;
      else ambiguous++;
    }
  }
  const counts = await countOutboxJobs(input.accountId, input.accountEpoch);
  return { attempted, transmitted, deferred, rejected, ambiguous, queued: counts.queued, inFlight: counts.inFlight };
}

/** Installs restrictive withdrawal for unsent work; dispatching requests finish truthfully. */
export async function installOutboxBarrier(accountId: string, accountEpoch: string): Promise<number> {
  return withdrawUnsentOutboxJobs(accountId, accountEpoch);
}

export async function getOutboxCounts(accountId: string, accountEpoch: string) {
  return countOutboxJobs(accountId, accountEpoch);
}
