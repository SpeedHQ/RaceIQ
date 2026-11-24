import { expect, test } from "bun:test";
import type { ChatGptSubscriptionState } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { ChatGptAccountError } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { createChatGptSubscriptionRoutes } from "../../src/routes/chatgpt-subscription-routes";
import type { CodexUsage } from "@raceiq/assistant/ai/codex-usage";

const base = "http://127.0.0.1:3117";
const path = "/api/auth/chatgpt-subscription";
const state: ChatGptSubscriptionState = { availability: "available", activeAccountId: null, accounts: [], attempt: null };

test("guards every account endpoint before invoking the account service", async () => {
  let trusted = false;
  let calls = 0;
  const quota = { status: "available", windows: [{ usedPercent: 0, windowDurationMins: 300, resetsAt: null }] } satisfies CodexUsage;
  let quotaReads = 0;
  const routes = createChatGptSubscriptionRoutes({
    isTrustedLocal: (request, requireOrigin) => trusted && (!requireOrigin || request.headers.get("Origin") === base),
    async codexUsage() { quotaReads++; return quota; },
    authorize: async (request) => request.method !== "GET" && request.headers.get("X-RaceIQ-CSRF") !== "csrf"
      ? new Response("Forbidden", { status: 403 }) : undefined,
    service: {
      async state() { calls++; return state; },
      async connect(accountId) {
        calls++;
        if (accountId !== null) throw new ChatGptAccountError("attempt_in_progress");
        return { attemptId: "attempt", authorizationUrl: "https://auth.openai.com/example" };
      },
      async cancel() { calls++; },
      async activate() { calls++; return state; },
      async signOut() { calls++; return { state, revocation: "unconfirmed" }; },
    },
  });
  function send(suffix = "", method = "GET", headers: Record<string, string> = {}, body?: string) {
    return routes.request(`${base}${path}${suffix}`, {
      method, body,
      headers: { host: "127.0.0.1:3117", "content-type": "application/json", ...headers },
    });
  }
  const local = { origin: base, "X-RaceIQ-CSRF": "csrf" };
  expect((await send("", "GET", { "X-Forwarded-For": "127.0.0.1" })).status).toBe(403);
  expect((await send("/codex-usage", "POST", local)).status).toBe(403);
  trusted = true;
  expect((await send("", "GET", { host: "other.test" })).status).toBe(403);
  expect((await send("/connect", "POST", { ...local, origin: "https://other.test" }, '{"accountId":null}')).status).toBe(403);
  expect((await send("/codex-usage", "POST", { ...local, origin: "https://other.test" })).status).toBe(403);
  expect((await send("/codex-usage", "POST", { origin: base })).status).toBe(403);
  expect(quotaReads).toBe(0);
  expect((await send("/connect", "POST", { origin: base }, '{"accountId":null}')).status).toBe(403);
  const malformed = await send("/connect", "POST", local, "{");
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
  expect(calls).toBe(0);

  const current = await send();
  expect(current.headers.get("Cache-Control")).toBe("no-store");
  expect(await current.json()).toEqual(state);
  const usage = await send("/codex-usage", "POST", local);
  expect(usage.status).toBe(200);
  expect(usage.headers.get("Cache-Control")).toBe("no-store");
  expect(await usage.json()).toEqual(quota);
  expect(quotaReads).toBe(1);
  const started = await send("/connect", "POST", local, '{"accountId":null}');
  expect(started.status).toBe(201);
  expect(started.headers.get("Cache-Control")).toBe("no-store");
  expect(await started.json()).toMatchObject({ attemptId: "attempt" });
  const conflict = await send("/connect", "POST", local, '{"accountId":"saved"}');
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "attempt_in_progress" });
  expect((await send("/connect/attempt", "DELETE", local)).status).toBe(204);
  expect((await send("/active", "PUT", local, '{"accountId":"saved"}')).status).toBe(200);
  const out = await send("/accounts/saved/session", "DELETE", local);
  expect(await out.json()).toEqual({ state, revocation: "unconfirmed" });
  expect(calls).toBe(6);
});

test("an unavailable runtime returns no account data and rejects mutations", async () => {
  const routes = createChatGptSubscriptionRoutes({ isTrustedLocal: () => true, authorize: async () => undefined, service: null });
  const headers = { host: "127.0.0.1:3117", origin: base, "content-type": "application/json" };
  const result = await routes.request(`${base}${path}`, { headers });
  expect(await result.json()).toEqual({ ...state, availability: "unavailable" });
  const connect = await routes.request(`${base}${path}/connect`, { method: "POST", headers, body: '{"accountId":null}' });
  expect(connect.status).toBe(503);
  expect(await connect.json()).toMatchObject({ code: "unavailable" });
  const usage = await routes.request(`${base}${path}/codex-usage`, { method: "POST", headers });
  expect(usage.status).toBe(503);
  expect(usage.headers.get("Cache-Control")).toBe("no-store");
});
