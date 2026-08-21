# RaceIQ Project Context

RaceIQ is a Bun, Hono, SQLite, React 19 telemetry application for Forza Motorsport 2023, F1 25, ACC, AC Evo, and iRacing.

## Repository boundaries

- `server/`: runtime, game parsers, telemetry pipeline, Hono routes, SQLite queries, AI integration.
- `client/`: React dashboard, TanStack Router/Query, Zustand, shadcn, Tailwind CSS v4.
- `shared/`: cross-runtime types, game adapters, racing metadata, telemetry contracts.
- `mastra/`: development-time agent definitions, tools, workflows, observability, and evals.
- `test/`, `client/test/`, `playwright/tests/`: focused server, client, and end-to-end contracts.

Read `docs/architecture/overview.md` when changing boundaries or data flow. Read responsibility-specific documentation before changing curated track data, game adapters, AI experiments, or release infrastructure.

## Research routing

- Query existing Graphify graph first for RaceIQ architecture, relationships, and change impact.
- Use librarian and official upstream documentation for dependency behavior.
- Route large logs, test output, JSON, and command output through context-mode.
- Use DeepWiki when local graph is absent, stale, or insufficient.

## Hard invariants

- Use static imports. Dynamic `await import(...)` is banned except documented platform switches where target module cannot exist on other platforms.
- Require `gameId`. Never silently fall back to `fm-2023` or another game.
- Use game registries and adapters. Game-specific behavior belongs in game-owned modules, not central condition chains.
- Client API calls use typed Hono RPC from `client/src/lib/rpc.ts`; do not add raw `fetch` calls for RaceIQ routes.
- Treat `client/src/routeTree.gen.ts` as generated output; never edit it manually.
- Treat installed dependencies as opaque. Use manifests, lockfiles, repository code, and official upstream documentation; do not inspect `node_modules` source.
- Avoid allocations, copies, and repeated computation in packet parsing, live telemetry, WebSocket broadcast, and render-frequency paths.

## Database changes

Drizzle supplies schema and query types, not runtime migrations.

1. Update `server/db/schema.ts`.
2. Append next migration version to `server/db/migrations.ts` with embedded SQL.
3. Add or update focused migration/query tests.

Never edit released historical migrations. Never use `db:push` as runtime migration path.

## Client contract

- Use TanStack Query for server state and Zustand for client/live state.
- UI styling uses semantic RaceIQ theme tokens. Avoid arbitrary typography utilities and raw palette colors.
- Reuse shadcn components and existing composition patterns.
- Verify changed web behavior in running application with browser tooling. Run theme contract test after styling changes.

## Verification

- Run focused commands, not project-wide suites during implementation.
- Server test command: `bun test --timeout 60000 <test-file>`.
- Full configured suite, only when warranted: `bun run test`.
- Client build: `bun run --cwd client build`.
- UI theme contract: `bun test --timeout 60000 test/tooling/theme-contract.test.ts`.
- Bug fixes must reproduce failure, then prove reproduction no longer fails.
- User-visible changes require release-note review through `update-release-notes` skill.

Keep changes narrow. Update every affected caller. Remove obsolete paths instead of adding compatibility shims unless external compatibility requires one.
