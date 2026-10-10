# Dashboard network access

RaceIQ's HTTP server binds to `127.0.0.1` by default. The dashboard and WebSocket are available on the same computer, with no additional login. Other local processes are trusted; this is not isolation from another program running under your account. UDP telemetry reception remains separate and can still receive game packets from other devices.

## Access from another device

For LAN access, configure these environment variables **before starting RaceIQ**:

| Variable | Purpose |
| --- | --- |
| `SERVER_HOST` | Bind address, such as the PC's LAN IP or `0.0.0.0`. Default: `127.0.0.1`. |
| `SERVER_PASSWORD` | A unique randomly generated password of at least 24 characters. Required for non-loopback bindings. |
| `SERVER_ALLOWED_ORIGINS` | Comma-separated exact browser origins, including scheme and port, such as `http://192.168.1.10:3117`. Required for non-loopback bindings. No wildcards, paths, or credentials. |

Use a password manager to generate the password. In development or Docker, put the settings in a private `.env` file (ignored by Git):

```dotenv
SERVER_HOST=0.0.0.0
SERVER_PASSWORD=<paste-a-unique-random-password-of-at-least-24-characters>
SERVER_ALLOWED_ORIGINS=http://192.168.1.10:3117
```

Replace the address with your PC's actual address and the password placeholder with your generated password. The browser prompts for HTTP Basic authentication: username **`raceiq`**, password **your configured password**. All requests, including local requests and WebSocket connections, require authentication when a password is configured. API clients must also send Basic authentication.

Basic authentication does not encrypt traffic. Use an HTTPS reverse proxy or an encrypted tunnel for untrusted networks; do not expose plain HTTP directly to the internet. Keep `SERVER_PASSWORD` configured even if the backend binds to loopback behind a public proxy. Add the exact public HTTPS origin to `SERVER_ALLOWED_ORIGINS`. Proxy both HTTP and WebSockets, preserve the Authorization header, and configure the upstream Host to a permitted address. Forwarded headers do not grant authentication or bypass origin checks.

For a compiled Windows install, set these variables in the environment of the process launching RaceIQ, then restart it. For Docker, follow the [Docker guide](docker.md).

## Development

Vite and the Portless proxy use loopback access. Development accepts browser origins on `localhost`, loopback IPs, and reserved `.localhost` names so dynamically assigned Vite/Studio ports and worktrees still work. These development allowances are disabled in production. Other domains must be listed explicitly in `SERVER_ALLOWED_ORIGINS`.

The shared Portless proxy must not be in LAN mode. If a previously started proxy is configured for LAN access, stop it explicitly and restart local development; RaceIQ does not silently replace another project's running proxy. Use the built application with the authenticated network settings above for LAN testing, or use an encrypted remote-development tunnel.

Changing `SERVER_HOST` does not expose Vite. If you configure `SERVER_PASSWORD` during development, the direct backend WebSocket connection may need a browser login at the backend address as well as at the frontend; ordinary local development does not need these LAN settings.

Passwords are server configuration, not client build variables. Never rename them with a `VITE_` or `RACEIQ_` prefix, which this project exposes to the client build.
