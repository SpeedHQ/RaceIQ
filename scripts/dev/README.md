# Development Scripts

Start local development services.

| Command | Purpose |
|---|---|
| `bun scripts/dev/dev.ts [--onboarding <value>]` | Start portless proxy, watched server, and client dev server concurrently. |
| `bun scripts/dev/dev-proxy.ts` | Stop existing portless proxy and start HTTP proxy on port `1355`. |
| `bun scripts/dev/mastra-studio.ts` | Start Mastra Studio on `PORT` (default `4111`) against local server port `3117`. |

Inputs: optional onboarding override, `PORT` for Mastra Studio, and local source/dependencies. Outputs: inherited child-process logs and exit status from development process.

Boundary: development orchestration only. Scripts do not build release artifacts or modify application service configuration.

Focused verification: run each command from repository root and confirm child process startup, inherited output, and non-zero propagation on failure.
