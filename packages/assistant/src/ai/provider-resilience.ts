/**
 * Deadline, retry and circuit-breaker policy for provider HTTP calls.
 *
 * A hosted provider is a network hop the user did not ask for. Two failure
 * modes must never reach the UI: a socket that never answers (spinner forever)
 * and a provider that is down (every message pays the same connect cost). This
 * module owns both, so the request paths in `providers.ts` only describe WHAT
 * to send.
 *
 * Deadline shape. Platform `fetch` exposes exactly two observable phases:
 * response headers and body chunks. A pure TCP-connect timer would need socket
 * events `fetch` does not expose, so `headersMs` is the earliest enforceable
 * bound and it covers DNS + TCP + TLS + upstream time-to-first-byte. `totalMs`
 * is a hard cap over every attempt and the body read, so retries can never
 * outlive the caller's patience.
 *
 * Retry shape. Only transport-class failures are retried: network errors,
 * deadlines, HTTP 429 and 5xx. 400/401/402/403/404/422 are decisions the
 * upstream already made — retrying them only doubles the latency of the error
 * the user must act on.
 *
 * Circuit shape. Consecutive transport failures open the breaker for a
 * cool-down; the next request after the cool-down is a single half-open probe.
 * Any response - including a 4xx - proves the link is alive and closes it.
 */
import { AiProviderError } from "./provider-error";

export type RequestDeadlines = {
  /** Max time to response headers (DNS + TCP + TLS + time-to-first-byte). */
  headersMs: number;
  /** Hard cap for the whole call, body included, shared by every attempt. */
  totalMs: number;
};

export const DEFAULT_REQUEST_DEADLINES: RequestDeadlines = {
  // DeepSeek answers a non-streaming completion only once the whole answer is
  // generated, so the header wait is a generation wait, not a handshake wait:
  // 2 minutes covers a 16k-token completion at ~130 tok/s, 3 minutes leaves
  // room to drain the body. Longer than that is a hang, not a slow answer.
  headersMs: 120_000,
  totalMs: 180_000,
};

export type RetryPolicy = {
  /** Attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Longest `Retry-After` honoured; a longer hint abandons the retry instead. */
  maxRetryAfterMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 20_000,
};

export type CircuitPolicy = {
  /** Consecutive transport failures that open the breaker. */
  failureThreshold: number;
  /** How long the breaker stays open before one half-open probe is allowed. */
  cooldownMs: number;
};

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export type ResilienceDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ResilientRequestOptions = {
  /** Provider label used in typed errors and as the default breaker bucket. */
  provider: string;
  modelId?: string | null;
  /** Breaker bucket; defaults to `provider`. */
  circuitKey?: string;
  deadlines?: Partial<RequestDeadlines>;
  retry?: Partial<RetryPolicy>;
  circuit?: Partial<CircuitPolicy>;
  /** Caller cancellation (route abort). Propagated untouched and never retried. */
  signal?: AbortSignal | null;
  send: (signal: AbortSignal) => Promise<Response>;
  deps?: ResilienceDeps;
};

type CircuitState = {
  consecutiveFailures: number;
  openedAt: number | null;
  probeInFlight: boolean;
};

const circuits = new Map<string, CircuitState>();

function circuitState(key: string): CircuitState {
  const existing = circuits.get(key);
  if (existing) return existing;
  const fresh: CircuitState = { consecutiveFailures: 0, openedAt: null, probeInFlight: false };
  circuits.set(key, fresh);
  return fresh;
}

/** Test/diagnostic hook: forget every breaker so a suite starts closed. */
export function resetProviderCircuits(): void {
  circuits.clear();
}

export function providerCircuitSnapshot(key: string): {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
} {
  const state = circuits.get(key);
  if (!state || state.openedAt === null) {
    return { state: "closed", consecutiveFailures: state?.consecutiveFailures ?? 0 };
  }
  return {
    state: state.probeInFlight ? "half-open" : "open",
    consecutiveFailures: state.consecutiveFailures,
  };
}

/** 429 and 5xx are the only statuses worth a second attempt. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/**
 * Exponential backoff with full jitter for the attempt that just failed
 * (1-based), raised to `retryAfterMs` when the upstream asked for longer.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
  retryAfterMs: number | null = null,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const backoff = Math.round(ceiling * random());
  return Math.max(backoff, retryAfterMs ?? 0);
}

function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1_000));
}

function headersTimeoutError(provider: string, modelId: string | null, ms: number): AiProviderError {
  return new AiProviderError(`${provider} did not start responding within ${seconds(ms)}s.`, {
    code: "timeout",
    provider,
    modelId,
    isRetryable: true,
  });
}

function totalTimeoutError(provider: string, modelId: string | null, ms: number): AiProviderError {
  return new AiProviderError(`${provider} did not finish responding within ${seconds(ms)}s.`, {
    code: "timeout",
    provider,
    modelId,
    isRetryable: true,
  });
}

function classifyTransportError(error: unknown, provider: string, modelId: string | null): AiProviderError {
  if (error instanceof AiProviderError) return error;
  const candidate = error as { name?: unknown; message?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  if (name === "AbortError" || name === "TimeoutError") {
    return new AiProviderError(`${provider} did not respond within the request deadline.`, {
      code: "timeout",
      provider,
      modelId,
      isRetryable: true,
    });
  }
  return new AiProviderError(`${provider} request failed: ${message}`, {
    code: "network",
    provider,
    modelId,
    isRetryable: true,
  });
}

/**
 * Returns a typed error when the breaker refuses the request, or null when the
 * request may proceed (claiming the half-open probe when applicable).
 */
function circuitBlockedError(
  key: string,
  provider: string,
  modelId: string | null,
  policy: CircuitPolicy,
  now: () => number,
): AiProviderError | null {
  const state = circuits.get(key);
  if (!state || state.openedAt === null) return null;
  const elapsed = now() - state.openedAt;
  if (elapsed < policy.cooldownMs) {
    const waitMs = policy.cooldownMs - elapsed;
    return new AiProviderError(
      `${provider} is unavailable after ${state.consecutiveFailures} consecutive failures. Try again in ${seconds(waitMs)}s.`,
      { code: "circuit-open", provider, modelId, isRetryable: false },
    );
  }
  if (state.probeInFlight) {
    return new AiProviderError(`${provider} is still checking whether it recovered. Try again shortly.`, {
      code: "circuit-open",
      provider,
      modelId,
      isRetryable: false,
    });
  }
  state.probeInFlight = true;
  return null;
}

function recordSuccess(key: string): void {
  const state = circuits.get(key);
  if (!state) return;
  state.consecutiveFailures = 0;
  state.openedAt = null;
  state.probeInFlight = false;
}

function recordFailure(key: string, policy: CircuitPolicy, now: () => number): void {
  const state = circuitState(key);
  state.consecutiveFailures += 1;
  state.probeInFlight = false;
  if (state.openedAt !== null) {
    // A failed half-open probe restarts the cool-down instead of reopening the
    // floodgates.
    state.openedAt = now();
    return;
  }
  if (state.consecutiveFailures >= policy.failureThreshold) state.openedAt = now();
}

function releaseProbe(key: string): void {
  const state = circuits.get(key);
  if (state) state.probeInFlight = false;
}

function detachAbortListener(signal: AbortSignal | null, listener: () => void): void {
  if (signal) signal.removeEventListener("abort", listener);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function sendWithHeadersDeadline(
  send: (signal: AbortSignal) => Promise<Response>,
  controller: AbortController,
  headersMs: number,
  error: AiProviderError,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(error);
      reject(error);
    }, Math.max(0, headersMs));
  });
  try {
    return await Promise.race([send(controller.signal), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body already consumed or closed; nothing to release.
  }
}

/**
 * Keep the hard deadline armed while the caller reads the body, and tear the
 * timer down as soon as the body closes so idle responses cannot leak timers.
 */
function guardResponseBody(
  response: Response,
  controller: AbortController,
  deadlineAt: number,
  now: () => number,
  timeout: AiProviderError,
  release: () => void,
): Response {
  const body = response.body;
  if (!body) {
    release();
    return response;
  }

  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    release();
  };

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      controller.abort(timeout);
      reject(timeout);
    }, Math.max(0, deadlineAt - now()));
  });
  // The race below owns this rejection; this keeps a late one quiet.
  expired.catch(() => {});

  const stream = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const result = await Promise.race([reader.read(), expired]);
        if (result.done) {
          cleanup();
          streamController.close();
          return;
        }
        streamController.enqueue(result.value);
      } catch (error) {
        cleanup();
        await reader.cancel(error).catch(() => {});
        streamController.error(error);
      }
    },
    cancel(reason) {
      cleanup();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Run one provider request under the deadline, retry and circuit policy.
 *
 * HTTP failures are handed back to the caller as the final `Response` so the
 * existing user-facing messages ("Invalid API key...", "OpenAI API error:
 * 503") stay exactly as they were; only transport failures become a thrown
 * `AiProviderError` here.
 */
export async function fetchWithResilience(options: ResilientRequestOptions): Promise<Response> {
  const { provider, modelId = null, send } = options;
  const deadlines: RequestDeadlines = { ...DEFAULT_REQUEST_DEADLINES, ...options.deadlines };
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const circuitPolicy: CircuitPolicy = { ...DEFAULT_CIRCUIT_POLICY, ...options.circuit };
  const now = options.deps?.now ?? Date.now;
  const sleep = options.deps?.sleep ?? defaultSleep;
  const random = options.deps?.random ?? Math.random;
  const callerSignal = options.signal ?? null;
  const circuitKey = options.circuitKey ?? provider;

  const deadlineAt = now() + deadlines.totalMs;
  let lastTransportError: AiProviderError | null = null;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    const blocked = circuitBlockedError(circuitKey, provider, modelId, circuitPolicy, now);
    if (blocked) throw blocked;

    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let response: Response;
    try {
      response = await sendWithHeadersDeadline(
        send,
        controller,
        Math.min(deadlines.headersMs, remainingMs),
        headersTimeoutError(provider, modelId, Math.min(deadlines.headersMs, remainingMs)),
      );
    } catch (error) {
      detachAbortListener(callerSignal, onCallerAbort);
      if (callerSignal?.aborted) {
        releaseProbe(circuitKey);
        throw callerSignal.reason instanceof Error ? callerSignal.reason : error;
      }
      lastTransportError = classifyTransportError(error, provider, modelId);
      recordFailure(circuitKey, circuitPolicy, now);
      if (attempt === retry.maxAttempts) break;
      const delay = retryDelayMs(attempt, retry, random);
      if (now() + delay >= deadlineAt) break;
      await sleep(delay);
      continue;
    }

    if (response.status >= 500) recordFailure(circuitKey, circuitPolicy, now);
    else recordSuccess(circuitKey);

    const finish = () =>
      guardResponseBody(
        response,
        controller,
        deadlineAt,
        now,
        totalTimeoutError(provider, modelId, deadlines.totalMs),
        () => detachAbortListener(callerSignal, onCallerAbort),
      );

    if (response.ok || !isRetryableStatus(response.status)) return finish();
    if (attempt === retry.maxAttempts) return finish();

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
    const cappedRetryAfter =
      retryAfterMs === null ? null : Math.min(retryAfterMs, retry.maxRetryAfterMs);
    const delay = retryDelayMs(attempt, retry, random, cappedRetryAfter);
    // A retry that cannot start inside the budget is not a retry.
    if (now() + delay >= deadlineAt) return finish();

    await discardBody(response);
    detachAbortListener(callerSignal, onCallerAbort);
    await sleep(delay);
  }

  throw lastTransportError ?? totalTimeoutError(provider, modelId, deadlines.totalMs);
}
