# Dashboard access and security

New desktop and self-hosted installs listen on loopback only. Page two of setup lets you enable password protection or explicitly continue without a password. Passwords require 8–1024 characters; numbers and special characters are optional. Protected setup signs you in automatically.

Anyone who can reach an unprotected instance can read and edit its data and settings and use configured AI chat. Password protection, listening interfaces, and browser-origin whitelisting are independent controls. UDP telemetry never requires a dashboard password, and changing access settings does not stop recording.

## Upgrades

The first dashboard visit after upgrading asks you to make the password choice once. It preserves recordings, settings, current page, language, network configuration, and onboarding progress. Existing all-interface listeners remain until you select individual interfaces. Existing protection uses the normal login screen.

An existing `SERVER_PASSWORD` is migrated to a salted hash and continues to override the stored password. Removing the override restores the stored password; it never silently disables protection. If that password is unknown, remove the override from the server and recovery process, restart, and use password recovery.

## Settings → Access & security

- Enable protection, change the password, or disable protection. Changing or disabling an existing password requires the current password. To disable protection, select the unprotected option, review the exposure warning, and submit Confirm settings; no separate acknowledgement toggle is required.
- Select localhost, individual LAN interfaces, or Tailscale interfaces. RaceIQ binds only selected addresses after restarting. Update Windows Firewall for the chosen TCP port if necessary.
- Leave **Browser-origin whitelist** off unless you want an explicit list of allowed browser origins. To enable it, turn on the toggle, enter any external origins, save, and restart. See [browser-origin whitelisting](#browser-origin-whitelist) for environment overrides and examples.
- Review saved dashboard URLs and the addresses currently listening. All network changes require a restart. A saved URL does not configure DNS, a firewall, or a tunnel.
- Sign out of the current browser session.

For another LAN device, select your PC's LAN address, save, restart, and open `http://<PC-LAN-IP>:3117` on that device. Sign in if protection is enabled. Select a Tailscale address for Tailnet access; if the whitelist is enabled, add its MagicDNS origin when using the hostname. Devices must already belong to the Tailnet.

Once a LAN interface is listening, **Open on another device** shows its dashboard link with **Copy link** and a QR code. Connect the other device to the same network and scan the code or open the copied link. Sign in with your dashboard password if protection is enabled. The QR code is generated locally and contains only the URL. Unsaved interface selections and interfaces awaiting a restart do not create active sharing links.

The HUD catalogue uses the same active LAN addresses and dashboard port as dashboard sharing. If multiple addresses are available, choose the address reachable from the viewing device. Localhost-only installations do not offer remote IP links. Unsaved interface changes do not make an address available; save and restart first. A hostname override remains available for an externally configured address.

The HUD hostname override changes links and QR codes only; it does not enable a network listener or authorize an external domain. When browser-origin whitelisting is enabled, include the HUD link's exact external origin (scheme, hostname, and port, without the `/portable/...` path) in **Settings → Access & security**. If `SERVER_ALLOWED_ORIGINS` is set, add the origin to that environment variable instead and restart. A nonempty `SERVER_ALLOWED_ORIGINS` explicitly enables the whitelist and overrides the UI setting.

During `bun run dev`, dashboard URLs and sharing links use the Vite dashboard port rather than the backend port, whose root page returns `ok`. Development binds additional dashboard listeners only to selected LAN/Tailscale addresses. Keep localhost selected for Portless development; deselecting it refuses startup rather than silently enabling it. Restart the full development command after changing interfaces. Allow the dashboard port through Windows Firewall for development testing. If `SERVER_ALLOWED_ORIGINS` is set, include the exact development dashboard origin as well; explicit environment allowlists remain authoritative.

Install Cloudflare Tunnel externally using [Cloudflare's instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Point it at a selected localhost address, forward HTTP and WebSockets, and, if the whitelist is enabled, add its public HTTPS origin. Proxies must overwrite forwarded host/protocol headers with the actual public address. Use HTTPS or an encrypted tunnel on untrusted networks.

## Browser-origin whitelist

The whitelist is **off by default**, including older saved configurations without the explicit toggle. Saved origin entries are retained but do not enable the whitelist by themselves. Turning the whitelist off keeps those entries for later use. Same-origin and cross-site request checks, password protection, and selected listening interfaces still apply; off does not mean arbitrary websites may access RaceIQ.

To enable the UI-managed whitelist:

1. Open **Settings → Access & security** and turn on **Browser-origin whitelist**.
2. Add external browser origins to **Browser origins for MagicDNS or Cloudflare Tunnel**, one per line. Include the scheme and any non-default port, but no path, credentials, or wildcard.
3. Save network access and restart RaceIQ.

Origins for selected listening interfaces are included automatically in the UI-managed whitelist. Add domains such as `http://raceiq-host.example-tailnet.ts.net:3117` or `https://raceiq.example.com` yourself. A HUD URL such as `http://raceiq-host.example-tailnet.ts.net:3117/portable/combo-1` needs the origin `http://raceiq-host.example-tailnet.ts.net:3117`, not the full URL.

A nonempty `SERVER_ALLOWED_ORIGINS` in `.env` **enables the whitelist even when the saved UI toggle is off**. It replaces the UI-managed list, and the toggle and origin field become read-only while the override is active:

```dotenv
SERVER_ALLOWED_ORIGINS=http://localhost:3117,http://127.0.0.1:3117,https://raceiq.example.com
```

The environment list must include every browser origin you intend to use, including localhost, selected LAN/Tailnet URLs, and external domains. Selected-interface origins are not automatically added to this override. In development, include the actual dashboard page origin and port, not only the backend port. Restart after changing `.env` or recreating a Docker container with a changed `--env-file`.

Removing or emptying `SERVER_ALLOWED_ORIGINS` restores the saved toggle and list after restart; it does not automatically turn the saved toggle off. The whitelist is not a password, firewall rule, DNS record, or tunnel configuration.

## Authentication and storage

Protection applies to application APIs and WebSockets on every address, including localhost. The public dashboard bundle exposes only the login/setup shell before authentication, without application data. Sign in using the password alone; no username is required.

Sessions last up to 30 days and survive restarts. Sign-out removes the current session. Changing or resetting a password invalidates previous sessions, including connected WebSockets. Cookies are HTTP-only, SameSite-protected, and Secure over HTTPS. Session-authenticated writes also require a CSRF token.

### API clients

Password-protected installations use browser sessions, including when the password comes from `SERVER_PASSWORD`; HTTP Basic authentication is not the application login mechanism. Send a JSON body containing `password` to `POST /api/auth/login`, retain the `raceiq_session` cookie from `Set-Cookie`, and retain the `X-RaceIQ-CSRF` response header. Send the cookie on subsequent API requests and WebSocket handshakes. Send `X-RaceIQ-CSRF` on mutating HTTP requests. `GET /api/auth/status` also returns the current session's `csrf` value.

Application API requests return `423` until setup is completed, `401` when a protected installation requires sign-in, and `403` for disallowed browser origins or a missing/incorrect CSRF token on a session-authenticated write. These checks also apply to live telemetry WebSockets where applicable.

Salted Argon2id password hashes and sessions are stored in the server database. Credential hashes are excluded from application settings, API responses, WebSocket state, exports, and logs. Keep the data directory private and preserve its database during upgrades and Docker container replacement.

## First-run ownership

Until the password choice is saved, only setup/login resources are available; application APIs and telemetry WebSockets are blocked. Concurrent visitors cannot both complete setup. Anyone reaching a remotely exposed, unconfigured instance can claim it: finish setup before exposing the instance.

Missing or corrupt authentication state in a previously configured database fails closed. RaceIQ does not recreate a missing state row or reopen setup. After setup, a non-secret `app.db.dashboard-access` marker beside the database also prevents a lost or replaced database from reopening setup. Preserve the marker with the database in backups and the Docker data volume. Restore a trusted database backup if access configuration was lost; do not delete the marker to bypass this check. Recovery can repair an invalid password hash when the remaining access configuration is intact.

## Password recovery

Use the same data directory as the server. On Windows:

```powershell
$env:DATA_DIR = 'C:\path\to\RaceIQ-data'
.\raceiq.exe auth reset
```

For source development or self-hosting:

```sh
DATA_DIR=/path/to/data bun apps/backend/src/index.ts auth reset
```

The command prompts for **New password** and **Confirm new password** without echoing input. Password arguments are rejected. It atomically replaces the hash and invalidates sessions while preserving recordings, settings, network choices, and recorder credentials. A running server reads the replacement immediately and disconnects invalidated WebSockets within one second.

Remove `SERVER_PASSWORD` from both the running server and recovery process first. Restart after removing environment overrides. A missing database/access row requires restoring a trusted backup rather than resetting a password.

## Disable password protection from the terminal

Use the same data directory as the server. This local administration command does not require the current dashboard password:

```powershell
$env:DATA_DIR = 'C:\path\to\RaceIQ-data'
.\raceiq.exe auth disable --confirm-exposure
```

For source development or self-hosting:

```sh
DATA_DIR=/path/to/data bun apps/backend/src/index.ts auth disable --confirm-exposure
```

For Docker:

```sh
docker exec raceiq ./raceiq auth disable --confirm-exposure
```

**Warning:** Anyone who can reach the dashboard can read and edit its data and settings and use configured AI chat after protection is disabled. The required `--confirm-exposure` flag acknowledges this exposure; without it, the command leaves protection unchanged.

The command removes the stored password hash and invalidates stored sessions while preserving recordings, settings, network choices, and recorder credentials. A running server reads the change immediately. Remove `SERVER_PASSWORD` from both the running server and command environment first, and restart after removing that override. Missing access configuration still requires restoring a trusted backup.

## Environment overrides and Docker

| Variable | Effect |
| --- | --- |
| `SERVER_HOST` | Overrides saved HTTP interfaces with one IP address or `localhost`. |
| `SERVER_PASSWORD` | Overrides the stored password and enables protection; requires 8–1024 characters. |
| `SERVER_ALLOWED_ORIGINS` | A nonempty value enables the whitelist regardless of the saved toggle and replaces all UI-managed origins with comma-separated exact HTTP(S) origins. |
| `SERVER_PORT` | HTTP/WebSocket port, default `3117`. |

Settings identifies active overrides. Remove the relevant variable and restart before changing that setting in the UI. Empty variables do not override saved settings. Never expose passwords through client-prefixed variables.

Docker explicitly sets `SERVER_HOST=0.0.0.0` inside the container so published ports work. Restrict host exposure with `--publish 127.0.0.1:3117:3117/tcp`, or deliberately publish on a selected LAN address. Passwords and browser origins can still be managed in the UI. Preserve `/data` through a volume.

Docker recovery:

```sh
docker exec -it raceiq ./raceiq auth reset
```

If `SERVER_PASSWORD` is set, recreate the container without it while retaining the same volume before recovery. See the [Docker guide](docker.md).

In development, Vite proxies API and WebSocket requests through the same page origin so they share the login cookie. Dashboard listeners follow the saved backend interface selections, including intentional existing all-interface configurations.
