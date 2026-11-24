import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const authorizeEndpoint = `${issuer}/api/accounts/authorize`;
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const revocationEndpoint = `${issuer}/api/accounts/oauth/revoke`;
const dynamicClientId = "dynamic_agent_client";
const requiredScopes = ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const requestedScopes = [...requiredScopes, "profile", "email"].join(" ");
const issuedClientId = z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/);
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string(),
});

export class ChatGptOAuthError extends Error {
  readonly code: "oauth_invalid" | "consent_denied" | "reauth_required" | "upstream_unavailable" | "plan_unavailable";

  constructor(code: ChatGptOAuthError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ChatGptRegistration = { clientId: string; subject: string; email: string | null };
export type ChatGptRenewableSession = { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };
export type ChatGptAuthorizationGrant = {
  registration: ChatGptRegistration;
  session: ChatGptRenewableSession & { idToken: string };
};

type Transaction = {
  redirectUri: string;
  registration: ChatGptRegistration | null;
  state: string;
  nonce: string;
  verifier: string;
};

function secret() {
  return randomBytes(32).toString("base64url");
}

export function createChatGptAuthorization(hostId: string, port: number, registration: ChatGptRegistration | null) {
  const transaction: Transaction = {
    redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    registration,
    state: secret(),
    nonce: secret(),
    verifier: secret(),
  };
  const url = new URL(authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: registration?.clientId ?? dynamicClientId,
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: transaction.redirectUri,
    scope: requestedScopes,
    resource,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"),
  }).toString();
  if (!registration) url.searchParams.set("agent_name_hint", "RaceIQ");
  return { transaction, authorizationUrl: url.href };
}

function matchesCallback(transaction: Transaction, url: URL) {
  const callback = new URL(transaction.redirectUri);
  if (url.origin !== callback.origin || url.pathname !== callback.pathname) return false;
  const states = url.searchParams.getAll("state");
  if (states.length !== 1) return false;
  const actual = Buffer.from(states[0]!);
  const expected = Buffer.from(transaction.state);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readCallback(transaction: Transaction, url: URL) {
  if (!matchesCallback(transaction, url)) throw new ChatGptOAuthError("oauth_invalid");
  const fields = url.searchParams;
  for (const key of ["code", "error", "client_id"]) {
    if (fields.getAll(key).length > 1) throw new ChatGptOAuthError("oauth_invalid");
  }
  if (fields.get("error") === "access_denied") throw new ChatGptOAuthError("consent_denied");
  if (fields.has("error")) throw new ChatGptOAuthError("oauth_invalid");
  const code = fields.get("code");
  const returnedClientId = fields.get("client_id");
  const client = issuedClientId.safeParse(returnedClientId ?? transaction.registration?.clientId);
  if (!code || !client.success || (transaction.registration && client.data !== transaction.registration.clientId)) {
    throw new ChatGptOAuthError("oauth_invalid");
  }
  return { code, clientId: client.data };
}

type FetchOAuth = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ChatGptOAuthClient {
  exchange(transaction: Transaction, callback: URL, signal: AbortSignal): Promise<ChatGptAuthorizationGrant>;
  refresh(clientId: string, refreshToken: string, signal: AbortSignal): Promise<ChatGptRenewableSession>;
  revoke(clientId: string, refreshToken: string, signal: AbortSignal): Promise<void>;
}

export function createChatGptOAuthClient(fetchOAuth: FetchOAuth = (url, init) => fetch(url, init)): ChatGptOAuthClient {
  async function request(url: string | URL, signal: AbortSignal, body?: URLSearchParams) {
    try {
      return await fetchOAuth(url, { signal, redirect: "error", ...(body && { method: "POST", body }) });
    } catch {
      throw new ChatGptOAuthError("upstream_unavailable");
    }
  }

  const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    [customFetch]: (url, init) => fetchOAuth(url, init),
  });

  async function grant(params: URLSearchParams, signal: AbortSignal, refresh: boolean) {
    params.set("resource", resource);
    const started = Date.now();
    const response = await request(tokenEndpoint, signal, params);
    const body: unknown = await response.json().catch(() => null);
    if (response.status !== 200) {
      const invalidGrant = z.object({ error: z.literal("invalid_grant") }).safeParse(body).success;
      if (invalidGrant) throw new ChatGptOAuthError(refresh ? "reauth_required" : "oauth_invalid");
      throw new ChatGptOAuthError("upstream_unavailable");
    }
    const result = tokenResponse.safeParse(body);
    if (!result.success) throw new ChatGptOAuthError("oauth_invalid");
    const received = result.data;
    const scopes = received.scope.split(/\s+/);
    if (requiredScopes.some((scope) => !scopes.includes(scope))) throw new ChatGptOAuthError("plan_unavailable");
    return {
      accessToken: received.access_token,
      refreshToken: received.refresh_token,
      idToken: received.id_token,
      expiresAt: started + received.expires_in * 1000,
      scopes,
    };
  }

  return {
    async exchange(transaction: Transaction, callback: URL, signal: AbortSignal) {
      const { code, clientId } = readCallback(transaction, callback);
      const session = await grant(new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: transaction.verifier,
        redirect_uri: transaction.redirectUri,
      }), signal, false);
      if (!session.idToken) throw new ChatGptOAuthError("oauth_invalid");
      const claims = await jwtVerify(session.idToken, keys, {
        algorithms: ["RS256"],
        issuer,
        audience: clientId,
        requiredClaims: ["exp", "iat", "sub", "nonce"],
      }).then(({ payload }) => payload).catch(() => { throw new ChatGptOAuthError("oauth_invalid"); });
      signal.throwIfAborted();
      if (!claims.sub || claims.nonce !== transaction.nonce
        || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)
        || (claims.azp !== undefined && claims.azp !== clientId)
        || (transaction.registration && claims.sub !== transaction.registration.subject)) {
        throw new ChatGptOAuthError("oauth_invalid");
      }
      const registration: ChatGptRegistration = {
        clientId,
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
      };
      return { registration, session: { ...session, idToken: session.idToken } };
    },
    async refresh(clientId: string, refreshToken: string, signal: AbortSignal) {
      const { accessToken, refreshToken: rotatedToken, expiresAt, scopes } = await grant(new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }), signal, true);
      signal.throwIfAborted();
      return { accessToken, refreshToken: rotatedToken, expiresAt, scopes };
    },
    async revoke(clientId: string, refreshToken: string, signal: AbortSignal) {
      const metadata = await request(`${issuer}/.well-known/openid-configuration`, signal);
      const parsed = z.object({ issuer: z.literal(issuer), revocation_endpoint: z.literal(revocationEndpoint) })
        .safeParse(await metadata.json().catch(() => null));
      if (metadata.status !== 200 || !parsed.success) throw new ChatGptOAuthError("upstream_unavailable");
      const result = await request(parsed.data.revocation_endpoint, signal, new URLSearchParams({
        client_id: clientId,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }));
      if (result.status !== 200) throw new ChatGptOAuthError("upstream_unavailable");
    },
  };
}

type OAuthOutcome =
  | { status: "authorized"; grant: ChatGptAuthorizationGrant }
  | { status: "cancelled" }
  | { status: "failed"; error: ChatGptOAuthError["code"] | "oauth_timeout" };

export function listenForChatGptAuthorization(oauth: ChatGptOAuthClient, hostId: string, registration: ChatGptRegistration | null) {
  const { promise: outcome, resolve } = Promise.withResolvers<OAuthOutcome>();
  const controller = new AbortController();
  let claimed = false;
  let settled = false;

  function finish(result: OAuthOutcome) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    controller.abort();
    void server.stop();
    resolve(result);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = (status: number, text: string) => new Response(text, {
        status,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
      const url = new URL(request.url);
      if (request.method !== "GET" || request.headers.get("Host") !== `127.0.0.1:${server.port}`
        || !matchesCallback(transaction, url)) {
        return response(400, "Invalid sign-in callback.");
      }
      if (claimed || settled) return response(409, "Sign-in callback already used.");
      claimed = true;
      try {
        const grant = await oauth.exchange(transaction, url, controller.signal);
        if (!settled) {
          finish({ status: "authorized", grant });
          return response(200, "Return to RaceIQ to finish connecting your account.");
        }
      } catch (failure) {
        finish({ status: "failed", error: failure instanceof ChatGptOAuthError ? failure.code : "upstream_unavailable" });
      }
      return response(400, "Sign-in did not complete. Return to RaceIQ.");
    },
  });
  const { transaction, authorizationUrl } = createChatGptAuthorization(hostId, server.port!, registration);
  const timer = setTimeout(() => finish({ status: "failed", error: "oauth_timeout" }), 5 * 60 * 1000);
  return { authorizationUrl, outcome, cancel: () => finish({ status: "cancelled" }) };
}
