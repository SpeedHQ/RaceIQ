import type { OnlineKeystore } from "@raceiq/online/contracts";
import { createOnlineTestFetch, createOnlineTestKeystore, readOnlineTestPlatform, type OnlineTestPlatform } from "./online-test-platform";

export type OnlinePlatform =
  | { kind: "production" }
  | { kind: "disabled" }
  | (OnlineTestPlatform & { kind: "local"; fetch: typeof globalThis.fetch; keystore: OnlineKeystore });

export class OnlinePlatformConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnlinePlatformConfigurationError";
  }
}

function localOrigin(value: string | undefined, name: string): string {
  if (value === "https://raceiq-dev.snazzie.space") return value;
  if (!value) throw new OnlinePlatformConfigurationError(`${name} must be a literal loopback HTTP(S) origin or the approved development API origin`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new OnlinePlatformConfigurationError(`${name} must be a literal loopback HTTP(S) origin or the approved development API origin`); }
  if (!(["http:", "https:"].includes(url.protocol))
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OnlinePlatformConfigurationError(`${name} must be a literal loopback HTTP(S) origin or the approved development API origin`);
  }
  return url.origin;
}
function authOrigin(value: string | undefined): string {
  if (!value) throw new OnlinePlatformConfigurationError("RACEIQ_DEV_AUTH_ORIGIN must be an HTTPS origin");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new OnlinePlatformConfigurationError("RACEIQ_DEV_AUTH_ORIGIN must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OnlinePlatformConfigurationError("RACEIQ_DEV_AUTH_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}


function createLocalFetch(baseUrl: string, supabaseUrl: string, fetcher: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const origins = new Set([baseUrl, supabaseUrl]);
  const assertAllowed = (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin) || url.username || url.password) {
      throw new OnlinePlatformConfigurationError("Local Online transport rejected an unconfigured origin");
    }
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

/** Resolves Online transport and credentials without consulting production defaults. */
export function resolveOnlinePlatform(env: NodeJS.ProcessEnv = process.env): OnlinePlatform {
  if (env.NODE_ENV === "production" && env.RACEIQ_E2E !== "1") return { kind: "production" };
  if (env.RACEIQ_E2E === "1") {
    const platform = readOnlineTestPlatform(env);
    if (!platform) throw new OnlinePlatformConfigurationError("E2E Online configuration is required");
    return {
      kind: "local",
      ...platform,
      fetch: createOnlineTestFetch(platform),
      keystore: createOnlineTestKeystore(),
    };
  }

  const values = [env.RACEIQ_DEV_ONLINE_ORIGIN, env.RACEIQ_DEV_AUTH_ORIGIN, env.RACEIQ_DEV_AUTH_PUBLISHABLE_KEY];
  if (values.every((value) => value === undefined || value === "")) return { kind: "disabled" };
  if (values.some((value) => value === undefined || value === "")) {
    throw new OnlinePlatformConfigurationError("Set RACEIQ_DEV_ONLINE_ORIGIN, RACEIQ_DEV_AUTH_ORIGIN, and RACEIQ_DEV_AUTH_PUBLISHABLE_KEY together");
  }
  const baseUrl = localOrigin(values[0], "RACEIQ_DEV_ONLINE_ORIGIN");
  const supabaseUrl = authOrigin(values[1]);
  const publishableKey = values[2]!;
  if (!publishableKey.trim() || publishableKey.length > 1024 || /[\r\n]/.test(publishableKey)) {
    throw new OnlinePlatformConfigurationError("RACEIQ_DEV_AUTH_PUBLISHABLE_KEY must be non-empty, single-line, and at most 1024 characters");
  }
  const platform = { baseUrl, authConfig: { supabaseUrl, publishableKey } };
  return { kind: "local", ...platform, fetch: createLocalFetch(baseUrl, supabaseUrl), keystore: createOnlineTestKeystore() };
}
