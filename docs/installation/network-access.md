# Dashboard access and security

New desktop and self-hosted installs listen on loopback only. Page two of setup lets you enable password protection or explicitly continue without a password. Passwords require 8–1024 characters; numbers and special characters are optional. Protected setup signs you in automatically.

Anyone who can reach an unprotected instance can access its data and controls. Password protection and network access are independent. UDP telemetry never requires a dashboard password, and changing access settings does not stop recording.

## Upgrades

The first dashboard visit after upgrading asks you to make the password choice once. It preserves recordings, settings, current page, language, network configuration, and onboarding progress. Existing all-interface listeners remain until you select individual interfaces. Existing protection uses the normal login screen.

An existing `SERVER_PASSWORD` is migrated to a salted hash and continues to override the stored password. Removing the override restores the stored password; it never silently disables protection. If that password is unknown, remove the override from the server and recovery process, restart, and use password recovery.

## Settings → Access & security

- Enable protection, change the password, or disable protection. Changing or disabling an existing password requires the current password. Disabling also requires confirmation of the exposure warning.
- Select localhost, individual LAN interfaces, or Tailscale interfaces. RaceIQ binds only selected addresses after restarting. Update Windows Firewall for the chosen TCP port if necessary.
- Add exact HTTP(S) browser origins for MagicDNS or Cloudflare Tunnel, one per line, including non-default ports. Examples: `http://raceiq-host.example-tailnet.ts.net:3117` and `https://raceiq.example.com`. No paths, credentials, or wildcards.
- Review saved dashboard URLs and the addresses currently listening. All network changes require a restart. A saved URL does not configure DNS, a firewall, or a tunnel.
- Sign out of the current browser session.

For another LAN device, select your PC's LAN address, save, restart, and open `http://<PC-LAN-IP>:3117` on that device. Sign in if protection is enabled. Select a Tailscale address for Tailnet access and add its MagicDNS origin if using the hostname. Devices must already belong to the Tailnet.

Once a LAN interface is listening, **Open on another device** shows its dashboard link with **Copy link** and a QR code. Connect the other device to the same network and scan the code or open the copied link. Sign in with your dashboard password if protection is enabled. The QR code is generated locally and contains only the URL. Unsaved interface selections and interfaces awaiting a restart do not create active sharing links.

During `bun run dev`, dashboard URLs and sharing links use the Vite dashboard port rather than the backend port, whose root page returns `ok`. Development binds additional dashboard listeners only to selected LAN/Tailscale addresses. Keep localhost selected for Portless development; deselecting it refuses startup rather than silently enabling it. Restart the full development command after changing interfaces. Allow the dashboard port through Windows Firewall for development testing. If `SERVER_ALLOWED_ORIGINS` is set, include the exact development dashboard origin as well; explicit environment allowlists remain authoritative.

Install Cloudflare Tunnel externally using [Cloudflare's instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Point it at a selected localhost address, forward HTTP and WebSockets, and add its public HTTPS origin. Proxies must overwrite forwarded host/protocol headers with the actual public address. Use HTTPS or an encrypted tunnel on untrusted networks.

## Authentication and storage

Protection applies to application APIs and WebSockets on every address, including localhost. The public dashboard bundle exposes only the login/setup shell before authentication, without application data. Sign in using the password alone; no username is required.

Sessions last up to 30 days and survive restarts. Sign-out removes the current session. Changing or resetting a password invalidates previous sessions, including connected WebSockets. Cookies are HTTP-only, SameSite-protected, and Secure over HTTPS. Session-authenticated writes also require a CSRF token.

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

## Environment overrides and Docker

| Variable | Effect |
| --- | --- |
| `SERVER_HOST` | Overrides saved HTTP interfaces with one IP address or `localhost`. |
| `SERVER_PASSWORD` | Overrides the stored password and enables protection; requires 8–1024 characters. |
| `SERVER_ALLOWED_ORIGINS` | Overrides saved origins with comma-separated exact HTTP(S) origins. |
| `SERVER_PORT` | HTTP/WebSocket port, default `3117`. |

Settings identifies active overrides. Remove the relevant variable and restart before changing that setting in the UI. Empty variables do not override saved settings. Never expose passwords through client-prefixed variables.

Docker explicitly sets `SERVER_HOST=0.0.0.0` inside the container so published ports work. Restrict host exposure with `--publish 127.0.0.1:3117:3117/tcp`, or deliberately publish on a selected LAN address. Passwords and browser origins can still be managed in the UI. Preserve `/data` through a volume.

Docker recovery:

```sh
docker exec -it raceiq ./raceiq auth reset
```

If `SERVER_PASSWORD` is set, recreate the container without it while retaining the same volume before recovery. See the [Docker guide](docker.md).

In development, Vite proxies API and WebSocket requests through the same page origin so they share the login cookie. Dashboard listeners follow the saved backend interface selections, including intentional existing all-interface configurations.
