import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createChatGptAuthorization,
  createChatGptOAuthClient,
  listenForChatGptAuthorization,
} from "../../src/runtime/chatgpt-subscription-oauth";

const clientId = "oaiapp_test";
const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const hostId = "urn:uuid:59e8ab31-52df-4a09-8a00-b60bb17daf9b";
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const signal = new AbortController().signal;
const key = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(key.publicKey), kid: "fixture", alg: "RS256" };
const otherKey = await generateKeyPair("RS256");
const tokenFields = { access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer", scope };

test("exchanges only a loopback callback bound to its state, client, nonce and PKCE verifier", async () => {
  const { authorizationUrl, transaction } = createChatGptAuthorization(hostId, 45678, null);
  const params = new URL(authorizationUrl).searchParams;
  const callback = new URL(transaction.redirectUri);
  callback.search = new URLSearchParams({ state: params.get("state")!, code: "code", client_id: clientId }).toString();
  expect(params.get("client_id")).toBe("dynamic_agent_client");
  expect(params.get("ext_agent_host_id")).toBe(hostId);
  expect(params.has("code_verifier")).toBe(false);

  let calls = 0;
  const oauth = createChatGptOAuthClient(async (url, init) => {
    calls++;
    if (String(url) === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    expect(url).toBe(`${issuer}/api/accounts/oauth/token`);
    expect(init?.redirect).toBe("error");
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code", client_id: clientId, code: "code",
      code_verifier: transaction.verifier, redirect_uri: callback.origin + callback.pathname, resource,
    });
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(params.get("code_challenge")!);
    const id_token = await new SignJWT({ nonce: params.get("nonce"), email: "raceiq@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer(issuer).setAudience(clientId)
      .setSubject("account").setIssuedAt().setExpirationTime("5m").sign(key.privateKey);
    return Response.json({ ...tokenFields, id_token });
  });

  const invalid = new URL(callback);
  invalid.searchParams.set("state", "wrong");
  await expect(oauth.exchange(transaction, invalid, signal)).rejects.toMatchObject({ code: "oauth_invalid" });
  const denied = new URL(callback);
  denied.searchParams.set("error", "access_denied");
  await expect(oauth.exchange(transaction, denied, signal)).rejects.toMatchObject({ code: "consent_denied" });
  expect(calls).toBe(0);
  const { registration, session } = await oauth.exchange(transaction, callback, signal);
  expect(registration).toEqual({ clientId, subject: "account", email: "raceiq@example.test" });
  expect(session.refreshToken).toBe("refresh");
  expect(calls).toBe(2);
});

test("rejects wrong client, identity, issuer, audience, nonce, signature and grant scope", async () => {
  const { transaction, authorizationUrl } = createChatGptAuthorization(hostId, 45678, {
    clientId, subject: "saved-account", email: "raceiq@example.test",
  });
  expect(new URL(authorizationUrl).searchParams.has("id_token_hint")).toBe(false);
  const callback = new URL(transaction.redirectUri);
  callback.search = new URLSearchParams({ state: transaction.state, code: "code" }).toString();
  for (const failure of ["client", "identity", "issuer", "audience", "nonce", "signature", "scope"]) {
    let exchanges = 0;
    const input = new URL(callback);
    if (failure === "client") input.searchParams.set("client_id", "oaiapp_different");
    const id_token = await new SignJWT({ nonce: failure === "nonce" ? "different" : transaction.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(failure === "issuer" ? "https://wrong.example" : issuer)
      .setAudience(failure === "audience" ? "oaiapp_different" : clientId)
      .setSubject(failure === "identity" ? "another-account" : "saved-account")
      .setIssuedAt().setExpirationTime("5m").sign(failure === "signature" ? otherKey.privateKey : key.privateKey);
    const oauth = createChatGptOAuthClient(async (url) => {
      if (String(url).endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
      exchanges++;
      return Response.json({ ...tokenFields, id_token, scope: failure === "scope" ? "openid offline_access resource.invoke" : scope });
    });
    await expect(oauth.exchange(transaction, input, signal)).rejects.toMatchObject({
      code: failure === "scope" ? "plan_unavailable" : "oauth_invalid",
    });
    expect(exchanges).toBe(failure === "client" ? 0 : 1);
  }
});

test("rotates the renewable token, maps invalid grants, and revokes only at the verified endpoint", async () => {
  const revocation = `${issuer}/api/accounts/oauth/revoke`;
  const requests: [string, RequestInit | undefined][] = [];
  const oauth = createChatGptOAuthClient(async (url, init) => {
    requests.push([String(url), init]);
    if (String(url).endsWith("openid-configuration")) return Response.json({ issuer, revocation_endpoint: revocation });
    if (String(url) === revocation) return new Response();
    return Response.json({ error: "invalid_grant", error_description: "private diagnostic" }, { status: 400 });
  });
  await expect(oauth.refresh(clientId, "old", signal)).rejects.toMatchObject({ code: "reauth_required", message: "reauth_required" });
  expect(Object.fromEntries(requests[0]![1]?.body as URLSearchParams)).toEqual({
    grant_type: "refresh_token", client_id: clientId, refresh_token: "old", resource,
  });
  const renewing = createChatGptOAuthClient(async () => Response.json({ ...tokenFields, refresh_token: "rotated" }));
  expect((await renewing.refresh(clientId, "old", signal)).refreshToken).toBe("rotated");
  await oauth.revoke(clientId, "rotated", signal);
  expect(requests[2]?.[0]).toBe(revocation);
  expect(Object.fromEntries(requests[2]![1]?.body as URLSearchParams)).toEqual({
    client_id: clientId, token: "rotated", token_type_hint: "refresh_token",
  });
  const badMetadata = createChatGptOAuthClient(async (_url, init) => {
    expect(init?.body).toBeUndefined();
    return Response.json({ issuer, revocation_endpoint: "https://other.example/revoke" });
  });
  await expect(badMetadata.revoke(clientId, "rotated", signal)).rejects.toMatchObject({ code: "upstream_unavailable" });
});

test("the real loopback listener consumes one callback and drops a cancelled in-flight grant", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const upstream = Promise.withResolvers<Response>();
  let calls = 0;
  const oauth = createChatGptOAuthClient((_url, init) => {
    calls++;
    started.resolve(init?.signal as AbortSignal);
    return upstream.promise;
  });
  const listener = listenForChatGptAuthorization(oauth, hostId, null);
  try {
    const params = new URL(listener.authorizationUrl).searchParams;
    const callback = new URL(params.get("redirect_uri")!);
    expect(callback.hostname).toBe("127.0.0.1");
    callback.search = new URLSearchParams({ state: "wrong", code: "code", client_id: clientId }).toString();
    expect((await fetch(callback)).status).toBe(400);
    expect(calls).toBe(0);
    callback.searchParams.set("state", params.get("state")!);
    const inFlight = fetch(callback);
    const exchangeSignal = await started.promise;
    expect((await fetch(callback)).status).toBe(409);
    listener.cancel();
    expect(await listener.outcome).toEqual({ status: "cancelled" });
    expect(exchangeSignal.aborted).toBe(true);
    upstream.resolve(Response.json(tokenFields));
    const response = await inFlight;
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toBe(1);
  } finally {
    listener.cancel();
    upstream.resolve(Response.json(tokenFields));
  }
});
