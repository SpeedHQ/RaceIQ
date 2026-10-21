export interface FetchTextOptions {
  headers?: Record<string, string>;
  retries?: number;
  retryDelayMs?: number | ((attempt: number) => number);
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Fetch text with caller-controlled headers and linear retry/backoff policy. */
export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<string> {
  const retries = Math.max(1, options.retries ?? 1);
  const retryDelayMs = options.retryDelayMs ?? 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, { headers: options.headers });
      if (!response.ok) throw new Error(`${response.status} for ${url}`);
      return await response.text();
    } catch (error) {
      if (attempt === retries - 1) throw error;
      const delay = typeof retryDelayMs === "function" ? retryDelayMs(attempt) : retryDelayMs;
      if (delay > 0) await sleep(delay);
    }
  }
  throw new Error("unreachable");
}
