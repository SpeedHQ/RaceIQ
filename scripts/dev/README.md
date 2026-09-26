# Development Scripts

Start local development services.

| Command | Purpose |
|---|---|
| `bun scripts/dev/dev.ts [--onboarding <value>]` | Share portless proxy, assign backend port, and start watched server and client. Linked worktrees also receive separate UDP ports. |
| `bun scripts/dev/dev-proxy.ts` | Start shared HTTP portless proxy on port `1355` without stopping existing proxy. |
| `bun scripts/dev/mastra-studio.ts` | Start Mastra Studio on `PORT` (default `4111`) against local server port `3117`. |

Inputs: optional onboarding override, `SERVER_PORT` for a fixed backend port, `PORT` for Mastra Studio, and local source/dependencies. Outputs: inherited child-process logs and exit status from development process. Portless provides `http://<branch>.raceiq-<worktree-id>.localhost:1355` for linked worktrees (actual URL printed at startup) and `http://raceiq.localhost:1355` for main checkout.

Boundary: development orchestration only. Scripts do not build release artifacts or modify application service configuration.

Focused verification: run each command from repository root and confirm child process startup, inherited output, and non-zero propagation on failure.
