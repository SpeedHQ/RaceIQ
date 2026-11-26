import { expect, test } from "bun:test";
import app from "../../src/routes/index";
import { createHttpAccess, hasDirectLocalAiAccess } from "../../src/runtime/http-access";
import { startHttpServer } from "../../src/runtime/http-server";

test("the app exposes an unavailable subscription state only through direct desktop ingress", async () => {
  const access = await createHttpAccess({ SERVER_HOST: "127.0.0.1", NODE_ENV: "production" });
  const server = startHttpServer({ app, access, port: 0, staticDir: null, devPublicDir: null });
  const url = new URL("/api/auth/chatgpt-subscription", server.url);
  try {
    const state = await fetch(url);
    expect(state.status).toBe(200);
    expect(state.headers.get("Cache-Control")).toBe("no-store");
    expect(await state.json()).toEqual({ availability: "unavailable", activeAccountId: null, accounts: [], attempt: null });

    const forwarded = await fetch(url, { headers: { "X-Forwarded-For": "127.0.0.1" } });
    expect(forwarded.status).toBe(403);
    const foreign = await fetch(url, { headers: { Origin: "https://foreign.example" } });
    expect(foreign.status).toBe(403);
    const bypass = await app.request(url.toString(), { headers: { Host: url.host } });
    expect(bypass.status).toBe(403);

    const connect = await fetch(`${url}/connect`, {
      method: "POST",
      headers: { Origin: url.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: null }),
    });
    expect(connect.status).toBe(503);
    expect(await connect.json()).toMatchObject({ code: "unavailable" });
  } finally {
    await server.stop(true);
  }
});

test("only authenticated direct same-origin HTTP requests carry local inference access across async work", async () => {
  const access = await createHttpAccess({
    SERVER_HOST: "127.0.0.1",
    SERVER_PASSWORD: "app-password",
    NODE_ENV: "production",
  });
  const app = {
    async fetch() {
      await Promise.resolve();
      return Response.json(hasDirectLocalAiAccess());
    },
  };
  const server = startHttpServer({ app, access, port: 0, staticDir: null, devPublicDir: null });
  const url = new URL("/api/local-ai-ingress", server.url);
  const headers = { Authorization: `Basic ${btoa("raceiq:app-password")}`, Origin: url.origin };
  try {
    const direct = await fetch(url, { method: "POST", headers });
    expect(await direct.json()).toBe(true);

    const forwarded = await fetch(url, { method: "POST", headers: { ...headers, Forwarded: "for=127.0.0.1" } });
    expect(await forwarded.json()).toBe(false);

    const originless = await fetch(url, { method: "POST", headers: { Authorization: headers.Authorization } });
    expect(await originless.json()).toBe(false);

    expect((await fetch(url, { method: "POST", headers: { Origin: url.origin } })).status).toBe(401);
    expect(await (await app.fetch()).json()).toBe(false);
  } finally {
    await server.stop(true);
  }
});
