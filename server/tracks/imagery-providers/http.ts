import type { TrackImageryFetcher } from "./types";

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 90_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(5_000, at - Date.now()));
  }
  return 250 * 3 ** attempt;
}

function pause(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function request(url: string, fetcher: TrackImageryFetcher, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const response = await fetcher(url, {
      ...init,
      headers: {
        Accept: "application/json,image/avif,image/webp,image/png,image/jpeg,*/*",
        "User-Agent": "RaceIQ track imagery curator",
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return response;
    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_REQUEST_ATTEMPTS - 1) {
      throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
    }
    const delay = retryDelayMs(response, attempt);
    await response.body?.cancel().catch(() => undefined);
    await pause(delay);
  }
  throw new Error(`${new URL(url).hostname} request failed`);
}

export async function responseBytes(response: Response, maxBytes = MAX_SOURCE_BYTES): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error("Imagery source response exceeds bounded size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error("Imagery source returned an invalid image size");
  return bytes;
}

export async function requestBytes(url: string, fetcher: TrackImageryFetcher, init?: RequestInit): Promise<Uint8Array> {
  return responseBytes(await request(url, fetcher, init));
}
