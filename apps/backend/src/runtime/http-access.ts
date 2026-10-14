import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { DashboardAuth } from "./dashboard-auth";

const sharedAuthorizationRequests = new WeakSet<Request>();
const sharedAuthorizationCache = new WeakMap<Request, Promise<Response | undefined>>();

export function beginRequestAuthorization(request: Request): void {
  sharedAuthorizationRequests.add(request);
}

export function endRequestAuthorization(request: Request): void {
  sharedAuthorizationRequests.delete(request);
  sharedAuthorizationCache.delete(request);
}

export async function createHttpAccess(env: NodeJS.ProcessEnv = process.env, auth?: DashboardAuth) {
  const network = auth ? await auth.getNetwork() : undefined;
  // Preserve Bun's existing all-interface listener for upgrades, including Docker.
  const hosts = env.SERVER_HOST ? [env.SERVER_HOST] : (network?.hosts ?? ["0.0.0.0"]);
  const hostname = hosts[0];
  const password = auth ? "" : env.SERVER_PASSWORD || "";
  // Release builds replace this exact process.env expression. An installed
  // binary must stay in production even without a runtime NODE_ENV variable.
  const development = process.env.NODE_ENV !== "production" && env.NODE_ENV !== "production";
  const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  const localHost = (host: string) => loopback(host) || (development && host.endsWith(".localhost"));
  if (!loopback(hostname) && !isIP(hostname)) throw new Error("SERVER_HOST must be an IP address or localhost");
  if (password && password.length < 8) throw new Error("SERVER_PASSWORD must contain at least 8 characters");

  const origins = new Set<string>();
  const port = Number(env.SERVER_PORT) || 3117;
  // Saved browser origins add domain names; they must not lock out selected
  // listeners. Resolve preserved wildcard listeners to current local addresses.
  const listenerHosts = new Set(hosts.filter((host) => host !== "0.0.0.0" && host !== "::"));
  if (auth && (hosts.includes("0.0.0.0") || hosts.includes("::"))) {
    for (const values of Object.values(networkInterfaces())) {
      for (const value of values ?? []) {
        if (hosts.includes("::") || value.family === "IPv4") listenerHosts.add(value.address);
      }
    }
  }
  const configuredOrigins =
    env.SERVER_ALLOWED_ORIGINS ||
    (auth && network?.originsEnabled
      ? [
          ...(network.origins ?? []),
          ...[...listenerHosts].map((host) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`),
          ...(listenerHosts.has("127.0.0.1") || listenerHosts.has("::1") ? [`http://localhost:${port}`] : []),
        ].join(",")
      : "");
  for (const value of configuredOrigins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
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
      if (origins.size > 0) return origins.has(origin) || (!env.SERVER_ALLOWED_ORIGINS && development && (localHost(url.hostname) || listenerHosts.has(url.hostname)));
      const target = new URL(request.url);
      const forwardedHost = request.headers.get("x-forwarded-host");
      const forwardedProtocol = request.headers.get("x-forwarded-proto") || target.protocol.slice(0, -1);
      // Reverse proxies must overwrite these headers with the public address.
      // Browser WebSockets cannot set them; cross-origin HTTP scripts require
      // a preflight, which lacks the spoofed values and is rejected. They do
      // not authenticate non-browser callers or override an explicit list.
      const forwardedOrigin = forwardedHost && !/[\s,/\\?#@]/.test(forwardedHost) && ["http", "https"].includes(forwardedProtocol) ? new URL(`${forwardedProtocol}://${forwardedHost}`).origin : null;
      return (
        origin === target.origin ||
        // TLS termination can change the scheme seen by Bun, but not the
        // browser-facing authority.
        (target.protocol === "http:" && url.protocol === "https:" && url.host === target.host) ||
        origin === forwardedOrigin ||
        // A proxy may also rewrite Host. Browsers control Sec-Fetch-Site and
        // cannot set it from script; same-origin preserves that supported path.
        // Non-browser callers can forge it, as they already can omit Origin.
        request.headers.get("sec-fetch-site") === "same-origin" ||
        // Local development tools have dynamically assigned ports. .localhost
        // is reserved for loopback, unlike arbitrary domains resolving locally.
        (development && (localHost(url.hostname) || url.hostname === target.hostname))
      );
    } catch {
      return false;
    }
  }

  async function authorizeUncached(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    // Forwarded headers never bypass authentication or Host consistency.
    // Custom deployment hostnames remain usable without new configuration.
    // Host/Origin checks are browser protections, not remote authentication.
    if (host && host.toLowerCase() !== url.host.toLowerCase()) {
      return new Response("Forbidden", { status: 403 });
    }
    if (auth && origins.size > 0 && ![...origins].some((value) => new URL(value).host === url.host) && !(development && localHost(url.hostname))) return new Response("Forbidden", { status: 403 });
    const origin = request.headers.get("origin");
    if (origin !== null && !allowsOrigin(origin, request)) return new Response("Forbidden", { status: 403 });
    if (!origin && request.headers.get("sec-fetch-site") === "cross-site") {
      const navigation = request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate" && !/^\/(?:api|studio-api|ws)(?:\/|$)/.test(url.pathname);
      if (!navigation) return new Response("Forbidden", { status: 403 });
    }
    // Browser preflight carries no credentials. Only trusted origins get past
    // the checks above; the subsequent actual request still needs authentication.
    if (origin && request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      // End preflight here: never forward an unauthenticated OPTIONS request
      // to static-file serving, Studio, or a WebSocket upgrade handler.
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") || "content-type",
          Vary: "Origin, Access-Control-Request-Headers",
        },
      });
    }
    if (auth) {
      const bootstrap = ["/api/auth/status", "/api/auth/setup", "/api/auth/login"].includes(url.pathname);
      // The public bundle contains only the login/setup shell. All application
      // data, Studio, and telemetry stay behind the gate below.
      const shell = !/^\/(?:api|studio-api|ws)(?:\/|$)/.test(url.pathname) && ["GET", "HEAD"].includes(request.method);
      if (bootstrap || shell) return;
      const status = await auth.status(request);
      if (status.pending) return Response.json({ error: "setup_required" }, { status: 423 });
      if (status.protected && !status.authenticated) return Response.json({ error: "login_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      if (status.csrf && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("x-raceiq-csrf") !== status.csrf) return new Response("Forbidden", { status: 403 });
      return;
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

  function authorize(request: Request): Promise<Response | undefined> {
    if (!sharedAuthorizationRequests.has(request)) return authorizeUncached(request);
    const cached = sharedAuthorizationCache.get(request);
    if (cached) return cached;
    const pending = authorizeUncached(request);
    sharedAuthorizationCache.set(request, pending);
    return pending;
  }
  return { hostname, hosts, port, authorize, allowsOrigin, usesSessions: !!auth };
}

export interface HttpAccess {
  hostname: string;
  hosts: string[];
  port: number;
  authorize(request: Request): Promise<Response | undefined>;
  allowsOrigin(origin: string, request: Request): boolean;
  usesSessions: boolean;
}
export let httpAccess: HttpAccess = await createHttpAccess();
export async function configureHttpAccess(auth: DashboardAuth, port = Number(process.env.SERVER_PORT) || 3117) {
  httpAccess = await createHttpAccess({ ...process.env, SERVER_PORT: String(port) }, auth);
}
