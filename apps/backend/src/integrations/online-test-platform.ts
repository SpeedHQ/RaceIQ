import type { OnlineKeystore } from "@raceiq/online/contracts";

export interface OnlineTestPlatform {
  baseUrl: string;
  authConfig: { supabaseUrl: string; publishableKey: string };
}
export class OnlineTestPlatformError extends Error {
  readonly reason: "e2e_online_requires_test_environment" | "e2e_online_configuration_required" | "e2e_online_origin_invalid" | "e2e_online_transport_blocked";
  constructor(reason: OnlineTestPlatformError["reason"]) {
    super(reason);
    this.reason = reason;
    this.name = "OnlineTestPlatformError";
  }
}

function loopbackOrigin(value: string | undefined, httpsOnly: boolean): string {
  if (!value) throw new OnlineTestPlatformError("e2e_online_configuration_required");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new OnlineTestPlatformError("e2e_online_origin_invalid"); }
  if ((url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:"))
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OnlineTestPlatformError("e2e_online_origin_invalid");
  }
  return url.origin;
}

/** Test mode never falls through to live credentials or hosted auth on missing configuration. */
export function readOnlineTestPlatform(env: NodeJS.ProcessEnv = process.env): OnlineTestPlatform | null {
  if (env.RACEIQ_E2E !== "1") return null;
  if (env.NODE_ENV !== "test") throw new OnlineTestPlatformError("e2e_online_requires_test_environment");
  const baseUrl = loopbackOrigin(env.RACEIQ_E2E_ONLINE_ORIGIN, false);
  const supabaseUrl = loopbackOrigin(env.RACEIQ_E2E_AUTH_ORIGIN, true);
  const publishableKey = env.RACEIQ_E2E_AUTH_PUBLISHABLE_KEY;
  if (!publishableKey?.trim() || publishableKey.length > 1024 || /[\r\n]/.test(publishableKey)) {
    throw new OnlineTestPlatformError("e2e_online_configuration_required");
  }
  return { baseUrl, authConfig: { supabaseUrl, publishableKey } };
}

/** Each isolated application launch starts without credentials; nothing reaches an OS store. */
export function createOnlineTestKeystore(): OnlineKeystore {
  const values = new Map<string, string>();
  return {
    async getSecret(key) { return values.get(key) ?? ""; },
    async setSecret(key, value) { if (value) values.set(key, value); else values.delete(key); },
  };
}

/** Both SDK transports and speculative preconnects are confined to the explicitly configured origins. */
export function createOnlineTestFetch(platform: OnlineTestPlatform, fetcher: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const origins = new Set([loopbackOrigin(platform.baseUrl, false), loopbackOrigin(platform.authConfig.supabaseUrl, true)]);
  const assertAllowed = (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin) || url.username || url.password) throw new OnlineTestPlatformError("e2e_online_transport_blocked");
  };
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    assertAllowed(input);
    return fetcher(input, { ...init, redirect: "error" });
  }, {
    preconnect(...args: Parameters<typeof globalThis.fetch.preconnect>) {
      assertAllowed(args[0]);
      fetcher.preconnect(...args);
    },
  });
}
