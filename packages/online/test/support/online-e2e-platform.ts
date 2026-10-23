import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const account = {
  id: "e2e-online-user",
  email: "online-e2e@example.invalid",
  app_metadata: { provider: "discord", providers: ["discord"] },
  user_metadata: { full_name: "Online E2E Driver", name: "Online E2E Driver", avatar_url: null },
};
const policy = {
  available: true,
  termsVersion: "e2e-terms-1",
  privacyVersion: "e2e-privacy-1",
  termsUrl: "https://127.0.0.1/terms",
  privacyUrl: "https://127.0.0.1/privacy",
};
const preferences = { visibility: "private" as "private" | "public", setupUploads: false };
let consentAccepted = false;
const acceptedAt = "2026-01-01T00:00:00.000Z";
const token = "online-e2e-access-token";
const refreshToken = "online-e2e-refresh-token";
const code = "online-e2e-one-time-code";
const codeChallenges = new Map<string, string>();

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function listen(server: HttpServer | HttpsServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Online E2E fixture did not bind a TCP port");
  return address.port;
}

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : resolve());
  return promise;
}

function bearer(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Online E2E request body");
  return value as Record<string, unknown>;
}

/** External provider fixture only; application handlers, RPC, worker, and storage remain real. */
export async function startOnlineE2EPlatform(): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-online-e2e-"));
  const keyPath = join(dir, "auth.key");
  const certPath = join(dir, "auth.crt");
  const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  if (certificate.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("OpenSSL is required to create the isolated Online E2E auth certificate");
  }

  const authServer = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://127.0.0.1");
    if (url.pathname === "/auth/v1/authorize" && request.method === "GET") {
      const redirectTo = url.searchParams.get("redirect_to");
      if (!redirectTo) return sendJson(response, 400, { error: "invalid_request" });
      let callback: URL;
      try { callback = new URL(redirectTo); } catch { return sendJson(response, 400, { error: "invalid_request" }); }
      if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname) || callback.pathname !== "/api/online/auth/callback") return sendJson(response, 400, { error: "invalid_request" });
      const challenge = url.searchParams.get("code_challenge");
      if (!challenge || url.searchParams.get("code_challenge_method")?.toUpperCase() !== "S256") return sendJson(response, 400, { error: "invalid_request" });
      codeChallenges.set(code, challenge);
      callback.searchParams.set("code", code);
      response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
      return response.end();
    }
    if (url.pathname === "/auth/v1/token" && request.method === "POST" && url.searchParams.get("grant_type") === "pkce") {
      const body = await readBody(request);
      const challenge = codeChallenges.get(String(body.auth_code));
      if (!challenge || typeof body.code_verifier !== "string" || createHash("sha256").update(body.code_verifier).digest("base64url") !== challenge) return sendJson(response, 400, { error: "invalid_grant" });
      codeChallenges.delete(String(body.auth_code));
      return sendJson(response, 200, { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: refreshToken, user: account });
    }
    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      if (!bearer(request)) return sendJson(response, 401, { message: "invalid token", code: "invalid_token" });
      return sendJson(response, 200, account);
    }
    if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
      response.writeHead(204, { "cache-control": "no-store" });
      return response.end();
    }
    return sendJson(response, 404, { error: "not_found" });
  });

  const apiServer = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/v1/consent") return sendJson(response, 200, policy);
    if (!bearer(request)) return sendJson(response, 401, { error: { code: "unauthorized" } });
    if (method === "GET" && /(?:\/me|\/profile)$/.test(url.pathname)) return sendJson(response, 200, { userId: account.id, displayName: account.user_metadata.name, avatarUrl: null });
    if (method === "GET" && /consent$/.test(url.pathname)) return sendJson(response, 200, { accepted: consentAccepted, currentAcceptance: consentAccepted ? { termsVersion: policy.termsVersion, privacyVersion: policy.privacyVersion, acceptedAt } : null, policy });
    if ((method === "POST" || method === "PUT") && /consent$/.test(url.pathname)) {
      const body = await readBody(request);
      if (body.termsVersion !== policy.termsVersion || body.privacyVersion !== policy.privacyVersion) return sendJson(response, 409, { error: { code: "POLICY_CHANGED" } });
      consentAccepted = true;
      return sendJson(response, 200, { acceptedAt });
    }
    if (method === "GET" && /preferences$/.test(url.pathname)) return sendJson(response, 200, preferences);
    if ((method === "PUT" || method === "PATCH") && /preferences$/.test(url.pathname)) {
      const body = await readBody(request);
      const next = (body.preferences && typeof body.preferences === "object" ? body.preferences : body) as Record<string, unknown>;
      if ((next.visibility !== "private" && next.visibility !== "public") || typeof next.setupUploads !== "boolean") return sendJson(response, 400, { error: { code: "invalid_request" } });
      preferences.visibility = next.visibility;
      preferences.setupUploads = next.setupUploads;
      return sendJson(response, 200, preferences);
    }
    if (method === "PATCH" && /(?:\/me|\/profile)$/.test(url.pathname)) {
      const body = await readBody(request);
      if (typeof body.displayName !== "string") return sendJson(response, 400, { error: { code: "invalid_request" } });
      account.user_metadata.name = body.displayName;
      account.user_metadata.full_name = body.displayName;
      return sendJson(response, 200, { userId: account.id, displayName: body.displayName, avatarUrl: null });
    }
    return sendJson(response, 404, { error: { code: "not_found" } });
  });

  try {
    const authPort = await listen(authServer);
    const apiPort = await listen(apiServer);
    let closed = false;
    return {
      env: {
        RACEIQ_E2E_ONLINE_ORIGIN: `http://127.0.0.1:${apiPort}`,
        RACEIQ_E2E_AUTH_ORIGIN: `https://127.0.0.1:${authPort}`,
        RACEIQ_E2E_AUTH_PUBLISHABLE_KEY: "online-e2e-publishable-key",
        NODE_EXTRA_CA_CERTS: certPath,
      },
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all([closeServer(apiServer), closeServer(authServer)]);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled([closeServer(apiServer), closeServer(authServer)]);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
