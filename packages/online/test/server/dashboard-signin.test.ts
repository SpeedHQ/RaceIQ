import { expect, test } from "bun:test";
import { createDashboardSignIn } from "../../server/dashboard-signin";

const session = (overrides: Record<string, unknown> = {}) => ({
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "discord-user" },
  ...overrides,
});

function fixture(options: { userId?: string; payload?: unknown } = {}) {
  let exchangeBody: Record<string, string> | null = null;
  const service = createDashboardSignIn({
    authConfig: { supabaseUrl: "https://auth.local", publishableKey: "test-key" },
    fetch: Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      exchangeBody = JSON.parse(String(init?.body)) as Record<string, string>;
      return Response.json(options.payload ?? session());
    }, { preconnect: globalThis.fetch.preconnect }),
    async verifyProfile(token) {
      return { userId: options.userId ?? "discord-user", displayName: token, avatarUrl: null };
    },
  });
  return {
    service,
    get exchangeBody() { return exchangeBody; },
    async start(callback = "https://dashboard.example/api/auth/discord/callback?flow=browser") {
      const attempt = await service.begin(callback);
      const authorization = new URL(attempt.authorizationUrl);
      const redirect = new URL(authorization.searchParams.get("redirect_to")!);
      return { attempt, authorization, redirect };
    },
  };
}
type Flow = { attempt: { attemptId: string; authorizationUrl: string; expiresAt: number }; authorization: URL; redirect: URL };

async function start(fx: { start(callback?: string): Promise<Flow> }, callbackUrl?: string): Promise<Flow> {
  return fx.start(callbackUrl);
}

async function callback(flow: Flow, code = "provider-code") {
  flow.redirect.searchParams.set("code", code);
  flow.redirect.searchParams.set("state", "provider-state");
  return flow.redirect.href;
}


test("dashboard PKCE roundtrip binds callback state, nonce, and verifier to one attempt", async () => {
  const fx = fixture();
  const flow = await start(fx);
  expect(flow.authorization.searchParams.get("provider")).toBe("discord");
  expect(flow.authorization.searchParams.get("code_challenge_method")).toBe("s256");
  const result = await fx.service.complete(flow.attempt.attemptId, await callback(flow));
  expect(result).toEqual({ userId: "discord-user" });
  const challenge = flow.authorization.searchParams.get("code_challenge")!;
  const verifier = fx.exchangeBody!.code_verifier;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(expectedChallenge).toBe(challenge);
  expect(fx.exchangeBody?.auth_code).toBe("provider-code");
  expect(fx.service.consume(flow.attempt.attemptId).session.refreshToken).toBe("refresh-token");
  expect(() => fx.service.consume(flow.attempt.attemptId)).toThrow("dashboard_signin_invalid");
  await expect(fx.service.complete(flow.attempt.attemptId, await callback(flow))).rejects.toThrow("dashboard_signin_invalid");
});

test("dashboard callback requires exact callback origin, query, nonce, and state", async () => {
  for (const mutate of [
    (url: URL) => { url.hostname = "attacker.example"; },
    (url: URL) => { url.searchParams.set("flow", "other-browser"); },
    (url: URL) => { url.searchParams.set("raceiq_auth_nonce", "forged"); },
    (url: URL) => { url.searchParams.set("raceiq_auth_state", "forged"); },
  ]) {
    const fx = fixture();
    const flow = await start(fx);
    const url = new URL(await callback(flow));
    mutate(url);
    await expect(fx.service.complete(flow.attempt.attemptId, url.href)).rejects.toThrow("dashboard_signin_invalid");
    expect(fx.exchangeBody).toBeNull();
  }
});

test("dashboard cancel, expiry, and wrong profile identity never create a completion", async () => {
  const canceled = fixture();
  const canceledFlow = await start(canceled);
  canceled.service.cancel(canceledFlow.attempt.attemptId);
  await expect(canceled.service.complete(canceledFlow.attempt.attemptId, await callback(canceledFlow))).rejects.toThrow("dashboard_signin_invalid");

  const expired = fixture();
  const expiredFlow = await start(expired);
  const now = Date.now;
  Date.now = () => now() + 11 * 60_000;
  try { await expect(expired.service.complete(expiredFlow.attempt.attemptId, await callback(expiredFlow))).rejects.toThrow("dashboard_signin_invalid"); }
  finally { Date.now = now; }

  const wrongUser = fixture({ userId: "different-user" });
  const wrongUserFlow = await start(wrongUser);
  await expect(wrongUser.service.complete(wrongUserFlow.attempt.attemptId, await callback(wrongUserFlow))).rejects.toThrow("dashboard_signin_invalid");
});
test("cancel during token exchange discards in-flight completion", async () => {
  const gate = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const service = createDashboardSignIn({
    authConfig: { supabaseUrl: "https://auth.local", publishableKey: "test-key" },
    fetch: Object.assign(async () => { started.resolve(); return gate.promise; }, { preconnect: globalThis.fetch.preconnect }),
    async verifyProfile() { return { userId: "discord-user", displayName: "Driver", avatarUrl: null }; },
  });
  const attempt = await service.begin("https://dashboard.example/api/auth/discord/callback?flow=browser");
  const callbackUrl = new URL(new URL(attempt.authorizationUrl).searchParams.get("redirect_to")!);
  callbackUrl.searchParams.set("code", "provider-code");
  callbackUrl.searchParams.set("state", "provider-state");
  const completing = service.complete(attempt.attemptId, callbackUrl.href);
  await started.promise;
  service.cancel(attempt.attemptId);
  gate.resolve(Response.json(session()));
  await expect(completing).rejects.toThrow("dashboard_signin_invalid");
  expect(() => service.consume(attempt.attemptId)).toThrow("dashboard_signin_invalid");
});

test("dashboard provider payload must contain a valid, unexpired bearer session", async () => {
  for (const payload of [
    session({ token_type: "mac" }),
    session({ access_token: "  " }),
    session({ refresh_token: "" }),
    session({ expires_in: Number.POSITIVE_INFINITY }),
    session({ expires_at: "NaN" }),
    session({ expires_at: 1 }),
    session({ user: { id: "  " } }),
  ]) {
    const fx = fixture({ payload });
    const flow = await start(fx);
    await expect(fx.service.complete(flow.attempt.attemptId, await callback(flow))).rejects.toThrow("dashboard_signin_invalid");
    expect(() => fx.service.consume(flow.attempt.attemptId)).toThrow("dashboard_signin_invalid");
  }
});

test("independent browser attempts keep separate state and verifier", async () => {
  const fx = fixture();
  const first = await start(fx, "https://dashboard.example/api/auth/discord/callback?flow=first");
  const second = await start(fx, "https://dashboard.example/api/auth/discord/callback?flow=second");
  expect(first.attempt.attemptId).not.toBe(second.attempt.attemptId);
  expect(first.authorization.searchParams.get("code_challenge")).not.toBe(second.authorization.searchParams.get("code_challenge"));
  await fx.service.complete(first.attempt.attemptId, await callback(first, "code-first"));
  const firstVerifier = fx.exchangeBody?.code_verifier;
  await fx.service.complete(second.attempt.attemptId, await callback(second, "code-second"));
  expect(fx.exchangeBody?.code_verifier).not.toBe(firstVerifier);
  expect(fx.service.consume(first.attempt.attemptId).session.userId).toBe("discord-user");
  expect(fx.service.consume(second.attempt.attemptId).session.userId).toBe("discord-user");
});
