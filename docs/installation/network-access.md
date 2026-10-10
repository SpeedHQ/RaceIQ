# Dashboard network access

Existing desktop, LAN, Tailnet, reverse-proxy, and Docker deployments do not need new environment variables after upgrading. RaceIQ continues listening on all IPv4 interfaces (`0.0.0.0`) by default. Password authentication is opt-in. UDP telemetry reception and recording are unchanged by these HTTP settings.

An unprotected remote deployment remains unprotected: anyone who can reach it can access its data and controls. Browser origin checks are not authentication and cannot prevent non-browser clients or DNS rebinding. User-friendly password setup and access settings are tracked in [#445](https://github.com/SpeedHQ/RaceIQ/issues/445).

## Optional settings

Set these in the environment before starting RaceIQ. Each setting works independently:

| Variable | Purpose |
| --- | --- |
| `SERVER_HOST` | HTTP bind address. Default: `0.0.0.0`. Set `127.0.0.1` for local-only access, a LAN IP for a particular interface, or `::` for an IPv6 listener. |
| `SERVER_PASSWORD` | Enable HTTP Basic authentication with a password of at least 8 characters. Unset or empty means no password. |
| `SERVER_ALLOWED_ORIGINS` | Optional comma-separated exact browser origins, including scheme and port. No wildcards, paths, or credentials. Does not require a password. |

For example, to explicitly trust a Tailnet IP, MagicDNS FQDN, and Cloudflare Tunnel domain without a password:

```dotenv
SERVER_ALLOWED_ORIGINS=http://100.101.102.103:3117,http://raceiq-host.example-tailnet.ts.net:3117,https://raceiq.example.com
```

Replace the example addresses with your own. Add `http://localhost:3117` and your LAN origin if you also use those browser addresses. An explicit list replaces the automatic origin rules below: every request carrying an Origin must match a listed origin, even in development. Scheme, hostname, and port must match (omitting a port means the scheme's default port). The list applies to API requests, CORS preflights, and WebSocket upgrades. It does not restrict non-browser clients that omit Origin, nor does it turn off the listener on other addresses.

## Compatibility when no list is supplied

An unset or empty list enables these rules:

- Same-origin requests work at the address used to open RaceIQ, including localhost, LAN IPs, Tailnet IPs/MagicDNS names, and custom domains. No fixed hostname allowlist is imposed.
- HTTPS reverse proxies may preserve the public Host while forwarding over HTTP. HTTPS origins matching that authority are accepted.
- Proxies that rewrite Host can supply a single public `X-Forwarded-Host` and `X-Forwarded-Proto` (`http` or `https`). The proxy must overwrite these headers with the actual public address, never pass arbitrary client values. Comma-separated forwarding chains are not accepted. If no protocol is supplied, the upstream request scheme is used. Browser WebSockets cannot set these custom headers, and cross-origin HTTP scripts cannot send them unless a preflight is approved.
- Browser HTTP requests also work through a Host-rewriting proxy when `Sec-Fetch-Site: same-origin` is preserved. Do not manufacture that header or overwrite cross-site values. WebSocket handshakes may omit it, so preserve the public Host, send the public forwarding headers, or explicitly list the browser-facing origin.
- Development also accepts loopback and reserved `.localhost` origins for Vite, Portless, and Studio, plus other ports on the request's hostname for LAN Vite access. Packaged production builds disable these development-only rules even when no runtime `NODE_ENV` variable exists.
- Unrelated and opaque (`null`) origins are rejected. Cross-site requests without Origin are rejected, except safe top-level dashboard navigation. Non-browser requests without Origin continue to work. Allowed CORS responses return the validated origin, never `*`.

Forwarded headers do not grant authentication or override an explicit origin list. Reverse proxies and Cloudflare Tunnel must forward both HTTP and WebSockets. An explicit origin list works even when the proxy rewrites the upstream Host or scheme and omits forwarding headers.

## Optional password protection

Set `SERVER_PASSWORD` to a unique password of at least 8 characters. Numbers and special characters are optional; using a password manager is recommended. The browser prompts for HTTP Basic authentication: username **`raceiq`**, password **your configured password**. All actual HTTP requests and WebSocket connections, including localhost, require authentication. Trusted CORS preflights do not require credentials, but the subsequent actual request does. API clients must send Basic authentication as well.

Basic authentication does not encrypt traffic. Use HTTPS or an encrypted tunnel on untrusted networks. When a reverse proxy is used, preserve the Authorization header. Setting a password does not require an origin list, and setting an origin list does not enable a password.

For development, place optional settings in a private `.env` file (ignored by Git). For Docker, pass the file using `--env-file .env`; see the [Docker guide](docker.md). For a compiled Windows install, set variables in the environment of the process launching RaceIQ, then restart it.

Vite and Portless retain their existing network behavior; `SERVER_HOST` controls the backend only. With a development password, a direct backend WebSocket may need a browser login at the backend address as well as the frontend. Passwords are server configuration: never rename them with a `VITE_` or `RACEIQ_` prefix, which exposes variables in client builds.
