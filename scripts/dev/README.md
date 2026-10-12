# Development Scripts

Start local development services.

| Command | Purpose |
|---|---|
| `bun scripts/dev/dev.ts [--onboarding <value>]` | Share portless proxy, assign backend port, and start watched server and client. Linked worktrees also receive separate UDP ports. |
| `bun scripts/dev/dev-proxy.ts` | Start shared HTTP portless proxy on port `1355` without stopping existing proxy. |
| `bun scripts/dev/mastra-studio.ts` | Start Mastra Studio on `PORT` (default `4111`) against local server port `3117`. |
| `bun run --cwd client i18n:compile` | Generate production Paraglide message modules and declarations, or reuse validated output. |

Inputs: optional onboarding override, `SERVER_PORT` for a fixed backend port, `PORT` for Mastra Studio, and local source/dependencies. Outputs: inherited child-process logs and exit status from development process. Portless provides `http://<branch>.raceiq-<worktree-id>.localhost:1355` for linked worktrees (actual URL printed at startup) and `http://raceiq.localhost:1355` for main checkout.

Startup does not open a browser automatically. Open the printed Portless URL manually when needed.

Vite listens on `127.0.0.1` for Portless. The launcher reads only saved network configuration from the running server's data directory and supplies selected listener addresses to Vite; additional TCP listeners bind those specific IPs and forward HTTP/WebSocket traffic to Vite. Both launchers load `.env.development`, so `DATA_DIR` and explicit `SERVER_HOST` overrides agree. Existing wildcard configurations expand to current interface addresses. Unselected interfaces do not get listeners, and a failed bind stops startup rather than broadening access. Localhost must remain selected for Portless development; otherwise startup fails. Restart the full development command after changing network interfaces. Sharing links use the actual dashboard port. Explicit `SERVER_ALLOWED_ORIGINS` must include that origin for LAN development requests.

Translation build reuse hashes message files, project settings, dependency lockfile, installed compiler version, and generation options. Every generated file is validated before reuse; missing, modified, or obsolete output triggers staged regeneration. Failed compilation preserves the previous valid output. Development watching keeps its separate locale-module profile.

Boundary: development orchestration and generated translation preparation. Release packaging remains under `packages/tooling-build/src/build/`; scripts here do not modify application service configuration.

Focused verification: run each command from repository root and confirm child process startup, inherited output, and non-zero propagation on failure.
