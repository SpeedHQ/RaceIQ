import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY_POLICY,
  fetchWithResilience,
  parseRetryAfter,
  providerCircuitSnapshot,
  resetProviderCircuits,
  retryDelayMs,
  type RetryPolicy,
} from "@raceiq/backend-core/ai/providers";
import { AiProviderError } from "@raceiq/backend-core/ai/provider-error";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Deterministic clock + sleep so retry sequences assert without real waiting. */
function fakeTime(start = 1_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0.5,
    },
  };
}

beforeEach(() => {
  resetProviderCircuits();
});

describe("fetchWithResilience — retries", () => {
  test("retries transport failures with exponential backoff and jitter, then succeeds", async () => {
    const { deps, sleeps } = fakeTime();
    let sends = 0;
    const response = await fetchWithResilience({
      provider: "DeepSeek",
      modelId: "deepseek-flash",
      retry: { maxAttempts: 3, baseDelayMs: 100 },
      deps,
      send: async () => {
        sends += 1;
        if (sends < 3) throw new TypeError("fetch failed: ECONNRESET");
        return jsonResponse({ ok: true });
      },
    });

    expect(sends).toBe(3);
    // full jitter: 100ms ceiling / 2 and 200ms ceiling / 2
    expect(sleeps).toEqual([50, 100]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("stops after the three-attempt cap and reports a typed network error", async () => {
    const { deps, sleeps } = fakeTime();
    let sends = 0;
    const error = await fetchWithResilience({
      provider: "DeepSeek",
      modelId: "deepseek-flash",
      deps,
      send: async () => {
        sends += 1;
        throw new TypeError("fetch failed");
      },
    }).catch((caught: unknown) => caught);

    expect(sends).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe("network");
    expect((error as AiProviderError).provider).toBe("DeepSeek");
    expect((error as AiProviderError).isRetryable).toBe(true);
  });

  test.each([400, 401, 402, 403, 404, 422])("never retries HTTP %i", async (status) => {
    const { deps, sleeps } = fakeTime();
    let sends = 0;
    const response = await fetchWithResilience({
      provider: "DeepSeek",
      deps,
      send: async () => {
        sends += 1;
        return new Response("nope", { status });
      },
    });

    expect(sends).toBe(1);
    expect(sleeps).toEqual([]);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("nope");
  });

  test("honours Retry-After on 429", async () => {
    const { deps, sleeps } = fakeTime();
    let sends = 0;
    const response = await fetchWithResilience({
      provider: "DeepSeek",
      retry: { maxAttempts: 3, baseDelayMs: 10, maxRetryAfterMs: 5_000 },
      deps,
      send: async () => {
        sends += 1;
        if (sends === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
        return jsonResponse({ ok: true });
      },
    });

    expect(sends).toBe(2);
    expect(sleeps).toEqual([2_000]);
    expect(response.status).toBe(200);
  });

  test("returns the last 5xx response so the caller keeps its user-facing message", async () => {
    const { deps } = fakeTime();
    let sends = 0;
    const response = await fetchWithResilience({
      provider: "DeepSeek",
      retry: { maxAttempts: 2, baseDelayMs: 10 },
      deps,
      send: async () => {
        sends += 1;
        return new Response("upstream exploded", { status: 503 });
      },
    });

    expect(sends).toBe(2);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("upstream exploded");
  });
});

describe("fetchWithResilience — deadlines", () => {
  test("aborts a hung request with a typed timeout error", async () => {
    let sends = 0;
    const error = await fetchWithResilience({
      provider: "DeepSeek",
      modelId: "deepseek-flash",
      deadlines: { headersMs: 25, totalMs: 500 },
      retry: { maxAttempts: 3, baseDelayMs: 5 },
      deps: { sleep: async () => {} },
      send: () =>
        new Promise<Response>((_resolve, reject) => {
          sends += 1;
          // Resolved only by the abort; mirrors a socket that never answers.
          setTimeout(() => reject(new DOMException("aborted", "AbortError")), 1_000);
        }),
    }).catch((caught: unknown) => caught);

    expect(sends).toBe(3);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe("timeout");
    expect((error as AiProviderError).message).toContain("did not start responding");
  });

  test("the total deadline covers the body, so a stalled body cannot hang the caller", async () => {
    const response = await fetchWithResilience({
      provider: "DeepSeek",
      deadlines: { headersMs: 500, totalMs: 40 },
      send: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { "content-type": "application/json" },
        }),
    });

    const error = await response.text().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe("timeout");
  });

  test("a caller abort is propagated untouched and never retried", async () => {
    const caller = new AbortController();
    let sends = 0;
    const pending = fetchWithResilience({
      provider: "DeepSeek",
      signal: caller.signal,
      deps: { sleep: async () => {} },
      send: (signal) => {
        sends += 1;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
      },
    });

    caller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(sends).toBe(1);
  });
});

describe("fetchWithResilience — circuit breaker", () => {
  test("opens after the failure threshold, fails fast, then recovers through a half-open probe", async () => {
    const provider = "breaker-test";
    let healthy = false;
    let sends = 0;
    const run = () =>
      fetchWithResilience({
        provider,
        circuit: { failureThreshold: 2, cooldownMs: 40 },
        retry: { maxAttempts: 1 },
        send: async () => {
          sends += 1;
          if (!healthy) throw new TypeError("fetch failed");
          return jsonResponse({ ok: true });
        },
      });

    await expect(run()).rejects.toMatchObject({ code: "network" });
    await expect(run()).rejects.toMatchObject({ code: "network" });
    expect(providerCircuitSnapshot(provider).state).toBe("open");

    const sendsWhileOpen = sends;
    await expect(run()).rejects.toMatchObject({ code: "circuit-open" });
    expect(sends).toBe(sendsWhileOpen);

    await new Promise((resolve) => setTimeout(resolve, 60));
    healthy = true;
    const response = await run();
    expect(response.status).toBe(200);
    expect(providerCircuitSnapshot(provider).state).toBe("closed");
  });

  test("a success resets the consecutive-failure count", async () => {
    const provider = "reset-test";
    await expect(
      fetchWithResilience({
        provider,
        retry: { maxAttempts: 1 },
        send: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toMatchObject({ code: "network" });
    expect(providerCircuitSnapshot(provider).consecutiveFailures).toBe(1);

    const response = await fetchWithResilience({ provider, send: async () => jsonResponse({ ok: true }) });
    expect(response.status).toBe(200);
    expect(providerCircuitSnapshot(provider)).toEqual({ state: "closed", consecutiveFailures: 0 });
  });

  test("a healthy request is unaffected: one send, body readable", async () => {
    let sends = 0;
    const response = await fetchWithResilience({
      provider: "DeepSeek",
      send: async () => {
        sends += 1;
        return jsonResponse({ analysis: "ok" });
      },
    });

    expect(sends).toBe(1);
    expect(await response.json()).toEqual({ analysis: "ok" });
  });
});

describe("retry helpers", () => {
  test("parseRetryAfter reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
  });

  test("retryDelayMs keeps exponential growth, jitter, and the Retry-After floor", () => {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 250 };
    const half = () => 0.5;

    expect(retryDelayMs(1, policy, half)).toBe(50);
    expect(retryDelayMs(2, policy, half)).toBe(100);
    expect(retryDelayMs(3, policy, half)).toBe(125); // capped at maxDelayMs 250
    expect(retryDelayMs(1, policy, half, 900)).toBe(900);
    expect(retryDelayMs(4, policy, () => 0)).toBe(0);
  });
});
