import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function createHttpAccess(env: NodeJS.ProcessEnv = process.env) {
  // Preserve Bun's existing all-interface listener for upgrades, including Docker.
  const hostname = env.SERVER_HOST || "0.0.0.0";
  const password = env.SERVER_PASSWORD || "";
  // Release builds replace this exact process.env expression. An installed
  // binary must stay in production even without a runtime NODE_ENV variable.
  const development = process.env.NODE_ENV !== "production" && env.NODE_ENV !== "production";
  const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  const localHost = (host: string) => loopback(host) || (development && host.endsWith(".localhost"));
  if (!loopback(hostname) && !isIP(hostname)) throw new Error("SERVER_HOST must be an IP address or localhost");
  if (password && password.length < 8) throw new Error("SERVER_PASSWORD must contain at least 8 characters");

  const origins = new Set<string>();
  for (const value of (env.SERVER_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.hostname.includes("*") || url.username || url.password || (value !== url.origin && value !== `${url.origin}/`)) {
      throw new Error("SERVER_ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or credentials");
    }
    origins.add(url.origin);
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`raceiq:${password}`);

  function allowsOrigin(origin: string, request: Request): boolean {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return false;
      // An explicit list replaces compatibility rules, independently of auth.
      if (origins.size > 0) return origins.has(origin);
      const target = new URL(request.url);
      const forwardedHost = request.headers.get("x-forwarded-host");
      const forwardedProtocol = request.headers.get("x-forwarded-proto") || target.protocol.slice(0, -1);
      // Reverse proxies must overwrite these headers with the public address.
      // Browser WebSockets cannot set them; cross-origin HTTP scripts require
      // a preflight, which lacks the spoofed values and is rejected. They do
      // not authenticate non-browser callers or override an explicit list.
      const forwardedOrigin = forwardedHost && !/[\s,\/\\?#@]/.test(forwardedHost)
        && ["http", "https"].includes(forwardedProtocol)
        ? new URL(`${forwardedProtocol}://${forwardedHost}`).origin
        : null;
      return origin === target.origin
        // TLS termination can change the scheme seen by Bun, but not the
        // browser-facing authority.
        || (target.protocol === "http:" && url.protocol === "https:" && url.host === target.host)
        || origin === forwardedOrigin
        // A proxy may also rewrite Host. Browsers control Sec-Fetch-Site and
        // cannot set it from script; same-origin preserves that supported path.
        // Non-browser callers can forge it, as they already can omit Origin.
        || request.headers.get("sec-fetch-site") === "same-origin"
        // Local development tools have dynamically assigned ports. .localhost
        // is reserved for loopback, unlike arbitrary domains resolving locally.
        || (development && (localHost(url.hostname) || url.hostname === target.hostname));
    } catch {
      return false;
    }
  }

  function authorize(request: Request): Response | undefined {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    // Forwarded headers never bypass authentication or Host consistency.
    // Custom deployment hostnames remain usable without new configuration.
    // Host/Origin checks are browser protections, not remote authentication.
    if (host && host.toLowerCase() !== url.host.toLowerCase()) {
      return new Response("Forbidden", { status: 403 });
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowsOrigin(origin, request)) return new Response("Forbidden", { status: 403 });
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
