import { randomUUID } from "node:crypto";
import { raceIqAuthConfig, type DesktopAuthOptions } from "@speedhq/live-client";

export interface DashboardSignInSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  discordAccountName: string | null;
  expiresAt: number;
}
type Profile = { userId: string; displayName: string; avatarUrl: string | null; discordUsername?: string | null };
type Attempt = { callback: URL; verifier: string; state: string; nonce: string; expiresAt: number; consumed: boolean };
type Completion = { session: DashboardSignInSession; profile: Profile; expiresAt: number };
const resultParameters = ["code", "state", "error", "error_code", "error_description"];
const nonceParameter = "raceiq_auth_nonce";
const stateParameter = "raceiq_auth_state";
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));

function discordAccountName(identities: unknown): string | null {
  if (!Array.isArray(identities)) return null;
  const discord = identities.find((identity) => identity && typeof identity === "object" && "provider" in identity && identity.provider === "discord");
  if (!discord || typeof discord !== "object" || !("identity_data" in discord) || !discord.identity_data || typeof discord.identity_data !== "object") return null;
  const metadata = discord.identity_data as Record<string, unknown>;
  for (const value of [metadata.full_name, metadata.name]) if (typeof value === "string" && value.trim()) return value;
  return null;
}
function parseSession(value: unknown): DashboardSignInSession {
  if (!value || typeof value !== "object") throw new Error("dashboard_signin_invalid");
  const session = value as Record<string, unknown>;
  const user = session.user as Record<string, unknown> | undefined;
  if (typeof session.access_token !== "string" || !session.access_token.trim() ||
      typeof session.refresh_token !== "string" || !session.refresh_token.trim() ||
      session.token_type !== "bearer" || typeof session.expires_in !== "number" ||
      !Number.isSafeInteger(session.expires_in) || session.expires_in <= 0 ||
      !user || typeof user.id !== "string" || !user.id.trim()) throw new Error("dashboard_signin_invalid");
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000) throw new Error("dashboard_signin_invalid");
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    userId: user.id,
    discordAccountName: discordAccountName(user.identities),
    expiresAt,
  };
}

export function createDashboardSignIn(options: {
  authConfig?: Required<Pick<DesktopAuthOptions, "supabaseUrl" | "publishableKey">>;
  fetch: typeof globalThis.fetch;
  verifyProfile(token: string, discordAccountName: string | null): Promise<Profile>;
}) {
  if ((options.authConfig?.supabaseUrl === undefined) !== (options.authConfig?.publishableKey === undefined)) throw new TypeError("Invalid dashboard auth configuration");
  const authOrigin = new URL(options.authConfig?.supabaseUrl ?? raceIqAuthConfig.supabaseUrl);
  if (authOrigin.protocol !== "https:" || authOrigin.username || authOrigin.password || authOrigin.search || authOrigin.hash || authOrigin.pathname !== "/") throw new TypeError("Invalid dashboard auth origin");
  const publishableKey = options.authConfig?.publishableKey ?? raceIqAuthConfig.publishableKey;
  if (!publishableKey.trim()) throw new TypeError("Invalid dashboard auth key");
  const attempts = new Map<string, Attempt>();
  const completions = new Map<string, Completion>();
  const ttl = 10 * 60_000;
  const prune = () => {
    const now = Date.now();
    for (const [id, attempt] of attempts) if (attempt.expiresAt <= now) { attempt.verifier = ""; attempts.delete(id); }
    for (const [id, completion] of completions) if (completion.expiresAt <= now) completions.delete(id);
  };
  return {
    async begin(callbackUrl: string) {
      prune();
      if (attempts.size + completions.size >= 128) throw new Error("dashboard_signin_limit");
      const callback = new URL(callbackUrl);
      if (!(callback.protocol === "http:" || callback.protocol === "https:") || callback.username || callback.password || callback.hash ||
          [nonceParameter, stateParameter, ...resultParameters].some(key => callback.searchParams.has(key))) throw new Error("invalid_callback");
      const verifier = randomToken();
      const challenge = encode(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const state = randomToken();
      const nonce = randomToken();
      const expiresAt = Date.now() + ttl;
      const callbackWithNonce = new URL(callback);
      callbackWithNonce.searchParams.set(nonceParameter, nonce);
      callbackWithNonce.searchParams.set(stateParameter, state);
      const authorization = new URL("/auth/v1/authorize", authOrigin);
      authorization.searchParams.set("provider", "discord");
      authorization.searchParams.set("redirect_to", callbackWithNonce.href);
      authorization.searchParams.set("code_challenge", challenge);
      authorization.searchParams.set("code_challenge_method", "s256");
      const attemptId = randomUUID();
      attempts.set(attemptId, { callback: callbackWithNonce, verifier, state, nonce, expiresAt, consumed: false });
      return { attemptId, authorizationUrl: authorization.href, expiresAt };
    },
    async complete(attemptId: string, callbackUrl: string) {
      prune();
      const attempt = attempts.get(attemptId);
      if (!attempt || attempt.consumed || attempt.expiresAt <= Date.now()) throw new Error("dashboard_signin_invalid");
      attempt.consumed = true;
      try {
        const returned = new URL(callbackUrl);
        const expected = new URL(attempt.callback);
        if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.username || returned.password || returned.hash) throw new Error("dashboard_signin_invalid");
        for (const key of resultParameters) if (returned.searchParams.getAll(key).length > 1) throw new Error("dashboard_signin_invalid");
        const code = returned.searchParams.get("code");
        const denied = returned.searchParams.has("error") || returned.searchParams.has("error_code");
        if (!code?.trim() || denied || returned.searchParams.get(stateParameter) !== attempt.state || returned.searchParams.get(nonceParameter) !== attempt.nonce) throw new Error("dashboard_signin_invalid");
        const actualQuery = new URL(returned);
        for (const key of resultParameters) actualQuery.searchParams.delete(key);
        actualQuery.searchParams.sort();
        expected.searchParams.sort();
        if (actualQuery.search !== expected.search || attempt.expiresAt <= Date.now()) throw new Error("dashboard_signin_invalid");
        const verifier = attempt.verifier;
        attempt.verifier = "";
        const response = await options.fetch(new URL("/auth/v1/token?grant_type=pkce", authOrigin), {
          method: "POST", headers: { apikey: publishableKey, "Content-Type": "application/json" },
          body: JSON.stringify({ auth_code: code, code_verifier: verifier }), credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error("dashboard_signin_invalid");
        const session = parseSession(await response.json());
        const profile = await options.verifyProfile(session.accessToken, session.discordAccountName);
        if (profile.userId !== session.userId || attempt.expiresAt <= Date.now() || attempts.get(attemptId) !== attempt) throw new Error("dashboard_signin_invalid");
        attempts.delete(attemptId);
        completions.set(attemptId, { session, profile, expiresAt: attempt.expiresAt });
        return { userId: session.userId };
      } catch (cause) {
        if (attempts.get(attemptId) === attempt) attempts.delete(attemptId);
        attempt.verifier = "";
        throw cause;
      }
    },
    consume(attemptId: string) {
      prune();
      const completion = completions.get(attemptId);
      if (!completion || completion.expiresAt <= Date.now()) throw new Error("dashboard_signin_invalid");
      completions.delete(attemptId);
      return completion;
    },
    cancel(attemptId: string) {
      const attempt = attempts.get(attemptId);
      if (attempt) attempt.verifier = "";
      attempts.delete(attemptId);
      completions.delete(attemptId);
    },
  };
}
