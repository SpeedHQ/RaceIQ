import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function createHttpAccess(env: NodeJS.ProcessEnv = process.env) {
  const hostname = env.SERVER_HOST || "127.0.0.1";
  const password = env.SERVER_PASSWORD || "";
  const development = env.NODE_ENV !== "production";
  const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  const localHost = (host: string) => loopback(host) || (development && host.endsWith(".localhost"));
  if (!loopback(hostname) && !isIP(hostname)) throw new Error("SERVER_HOST must be an IP address or localhost");
  if (password && password.length < 24) throw new Error("SERVER_PASSWORD must contain at least 24 characters");
  if (!loopback(hostname) && !password) throw new Error("Non-loopback SERVER_HOST requires SERVER_PASSWORD");

  const origins = new Set<string>();
  for (const value of (env.SERVER_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (value !== url.origin && value !== `${url.origin}/`)) {
      throw new Error("SERVER_ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or credentials");
    }
    origins.add(url.origin);
  }
  if (!loopback(hostname) && origins.size === 0) throw new Error("Non-loopback SERVER_HOST requires SERVER_ALLOWED_ORIGINS");
  if (!password && [...origins].some((origin) => !localHost(new URL(origin).hostname))) {
    throw new Error("Non-local SERVER_ALLOWED_ORIGINS requires SERVER_PASSWORD");
  }
  const authorities = new Set([...origins].map((origin) => new URL(origin).host));
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`raceiq:${password}`);

  function allowsOrigin(origin: string, requestUrl: string): boolean {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return false;
      return origin === new URL(requestUrl).origin || origins.has(origin)
        // Local development tools have dynamically assigned ports. .localhost
        // is reserved for loopback, unlike arbitrary domains resolving locally.
        || (development && localHost(url.hostname));
    } catch {
      return false;
    }
  }

  function authorize(request: Request): Response | undefined {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    // Do not trust X-Forwarded-* headers for authentication or host validation.
    if ((host && host.toLowerCase() !== url.host.toLowerCase()) || (!localHost(url.hostname) && !authorities.has(url.host))) {
      return new Response("Forbidden", { status: 403 });
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowsOrigin(origin, request.url)) return new Response("Forbidden", { status: 403 });
    if (!origin && request.headers.get("sec-fetch-site") === "cross-site") {
      const navigation = request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate"
        && !/^\/(?:api|studio-api|ws)(?:\/|$)/.test(url.pathname);
      if (!navigation) return new Response("Forbidden", { status: 403 });
    }
    // Browser preflight carries no credentials. Only trusted origins get past
    // the checks above; the subsequent actual request still needs authentication.
    if (origin && request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      // End preflight here: never forward an unauthenticated OPTIONS request
      // to static-file serving, Studio, or a WebSocket upgrade handler.
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") || "content-type",
        "Vary": "Origin, Access-Control-Request-Headers",
      } });
    }
    if (password) {
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.get("authorization") || "");
      if (!match || !timingSafeEqual(digest(Buffer.from(match[1], "base64").toString("utf8")), expected)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="RaceIQ", charset="UTF-8"', "Cache-Control": "no-store" },
        });
      }
    }
  }

  return { hostname, authorize, allowsOrigin };
}

export type HttpAccess = ReturnType<typeof createHttpAccess>;
export const httpAccess = createHttpAccess();
