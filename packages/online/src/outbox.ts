import {
  countOutboxJobs,
  ensureOutboxStorage,
  getOutboxJob,
  listDeliverableOutboxJobs,
  beginOutboxAttempt,
  settleOutboxDelivery,
  recordOutboxAcceptance,
  withdrawUnsentOutboxJobs,
  type OutboxJob,
} from "./outbox-storage";

export const MAX_UPLOAD_ATTEMPTS = 5;

export type UploadOutcome =
  | { readonly kind: "request_accepted"; readonly remoteJobId: string }
  | { readonly kind: "withdrawn" }
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

export type DeliveryResult =
  | { readonly kind: "ack" }
  | { readonly kind: "retry"; readonly retryNotBeforeAt?: number };

export type ProcessOutboxDeliveryInput = {
  readonly reference: { readonly rowId: number; readonly uploadKey: string };
  readonly accountId: string;
  readonly accountEpoch: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly dispatch: (job: OutboxJob) => Promise<UploadOutcome>;
  readonly dispatchUnderPrivacyBarrier: DispatchUnderPrivacyBarrier;
  readonly shouldContinue?: () => boolean;
};

function validErrorCode(code: string): string {
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : "internal_error";
}

export async function processOutboxDelivery(input: ProcessOutboxDeliveryInput): Promise<DeliveryResult> {
  await ensureOutboxStorage();
  const current = await getOutboxJob(input.reference.rowId, input.accountId);
  if (!current || current.uploadKey !== input.reference.uploadKey ||
      ["transmitted", "withdrawn", "rejected"].includes(current.status)) return { kind: "ack" };
  const job = await beginOutboxAttempt({
    rowId: current.rowId, accountId: input.accountId, accountEpoch: input.accountEpoch,
    uploadKey: input.reference.uploadKey, attempts: input.attempts,
  });
  if (!job) return { kind: "retry" };
  let sendInvoked = false;
  let result: DispatchResult;
  try {
    result = await input.dispatchUnderPrivacyBarrier(job, async () => {
      if (sendInvoked || (input.shouldContinue && !input.shouldContinue())) {
        return { kind: "definitely_not_sent", code: "service_unavailable", retryable: true };
      }
      sendInvoked = true;
      try { return await input.dispatch(job); }
      catch { return { kind: "ambiguous", code: "internal_error" }; }
    });
  } catch {
    result = { authorized: true, outcome: { kind: "ambiguous", code: "internal_error" } };
  }
  if (!result.authorized) {
    if (sendInvoked) {
      await settleOutboxDelivery({ job, status: "ambiguous", errorCode: "internal_error" });
      return { kind: "retry" };
    }
    await settleOutboxDelivery({ job, status: "withdrawn", errorCode: "dispatch_barrier" });
    return { kind: "ack" };
  }
  if (!sendInvoked) {
    await settleOutboxDelivery({ job, status: "ambiguous", errorCode: "internal_error" });
    return { kind: "retry" };
  }
  const outcome = result.outcome;
  const wasAmbiguous = current.status === "ambiguous";
  if (outcome.kind === "request_accepted") {
    if (await recordOutboxAcceptance(job, outcome.remoteJobId)) return { kind: "ack" };
    const latest = await getOutboxJob(job.rowId, input.accountId);
    if (latest?.uploadKey === input.reference.uploadKey &&
        ["transmitted", "withdrawn", "rejected"].includes(latest.status)) return { kind: "ack" };
    return { kind: "retry" };
  }
  if (outcome.kind === "withdrawn") {
    await settleOutboxDelivery({ job, status: "withdrawn", errorCode: "dispatch_barrier" });
    return { kind: "ack" };
  }
  if (outcome.kind === "definitely_not_sent") {
    const retryNotBeforeAt = Number.isSafeInteger(outcome.retryAfterMs) && Number(outcome.retryAfterMs) >= 0
      ? Date.now() + Number(outcome.retryAfterMs) : undefined;
    if (wasAmbiguous) {
      await settleOutboxDelivery({ job, status: "ambiguous", retryNotBeforeAt, errorCode: validErrorCode(outcome.code) });
      return { kind: "retry", ...(retryNotBeforeAt === undefined ? {} : { retryNotBeforeAt }) };
    }
    if (outcome.retryable && input.attempts < input.maxAttempts) {
      await settleOutboxDelivery({ job, status: "pending", retryNotBeforeAt,
        errorCode: validErrorCode(outcome.code) });
      return { kind: "retry", ...(retryNotBeforeAt === undefined ? {} : { retryNotBeforeAt }) };
    }
  }
  if (outcome.kind === "ambiguous") {
    await settleOutboxDelivery({ job, status: "ambiguous", errorCode: validErrorCode(outcome.code) });
    return { kind: "retry" };
  }
  await settleOutboxDelivery({ job, status: "rejected", errorCode: validErrorCode(outcome.code) });
  return { kind: "ack" };
}

/** Installs restrictive withdrawal for unsent work; dispatching requests finish truthfully. */
export async function installOutboxBarrier(accountId: string, accountEpoch: string): Promise<number> {
  return withdrawUnsentOutboxJobs(accountId, accountEpoch);
}

export async function getOutboxCounts(accountId: string, accountEpoch: string) {
  return countOutboxJobs(accountId, accountEpoch);
}

export { listDeliverableOutboxJobs };

