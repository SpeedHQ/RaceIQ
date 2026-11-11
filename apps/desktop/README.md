# RaceIQ macOS host

This workspace owns the native Tauri window and its supervised compiled Bun
backend. It does not run telemetry or database logic in Rust. See the
[architecture overview](../../docs/architecture/overview.md) for service boundaries.

## Build

Use the root manifest's pinned Bun version, Rust and Xcode on Apple Silicon:

```sh
bun install --frozen-lockfile
bun run desktop:build
```

Output: `apps/desktop/src-tauri/target/release/bundle/macos/RaceIQ.app`.
The app bundles `dist/` as its backend resources, including native addons,
workers, catalogs and client assets. The local artifact is ad-hoc signed; it is
not Developer ID-signed or notarized for public distribution.

After a backend build, `bun run --cwd apps/desktop native:dev` runs the native
debug host. Backend sources are compiled by `bun run build:browser`; the host
does not depend on an externally installed Bun at runtime.

## Runtime contract

Rust starts only the bundled backend with `RACEIQ_DESKTOP=1`, an absolute
`DATA_DIR` and `SERVER_PORT=0`. The OS allocates an unused HTTP port; desktop
mode never clears an occupied port. Saved dashboard listener settings remain
active for other devices, with loopback added for the native window. A standalone JSON
stdout record `{type:"raceiq-ready",protocolVersion:1,url,udpPort,udpListening}`
announces readiness after initialization. Rust validates the loopback URL before
navigating the window. Startup failure and unexpected exit produce native error
dialogs. UDP bind failure leaves historical data usable and is reported in
readiness and existing backend diagnostics.

The tray menu controls whether the app starts at login and whether closing the
window hides RaceIQ or quits it. Quit requests SIGTERM and waits for Bun's
recording/worker/database drains. The shell does not hard-kill capture work.
Only one instance is admitted; launching again focuses the existing window.
The application page has no Tauri shell, filesystem or general IPC capabilities.

Default data: existing `~/RaceIQ` when it contains `app.db`; otherwise the
platform app data directory. For isolated testing, set
`RACEIQ_DESKTOP_DATA_DIR` to an absolute directory before launching. The shell
preserves saved dashboard network listeners and origin rules, and adds local
loopback access for its own window. It refuses startup when the configured
server port is already occupied so it cannot start a second backend beside an
existing server.

## Verification

```sh
bun test apps/backend/test/runtime/desktop-host.test.ts apps/backend/test/runtime/desktop-lifecycle.test.ts --timeout 60000
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The backend tests cover port allocation, port ownership, loopback confinement,
readiness, persisted settings across restart and clean shutdown. Rust tests
cover readiness URL validation. Neither substitutes for launching the `.app`,
recording live UDP in it, checking WKWebView, or testing shutdown during capture.
