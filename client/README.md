# Client

`client/` contains RaceIQ browser UI: React views, TanStack Router route definitions, TanStack Query server state, TanStack Store client state, shared UI primitives, and Storybook fixtures. Keep browser presentation here; server telemetry computation and authoritative session state stay outside this package.

## Boundaries

- Feature folders under `src/components/` own page views, containers, domain interactions, and feature-specific rendering. Move behavior with its feature instead of growing a cross-feature utility.
- Shared primitives live under `src/components/ui/`; shared hooks, helpers, stores, and data live in their owning `src/hooks/`, `src/lib/`, `src/stores/`, or `src/data/` module. Shared code must not import feature code.
- Use direct `@/` imports across feature boundaries and relative imports within one feature. Do not add barrel `index` files, compatibility exports, or deprecated path shims.
- Route files under `src/routes/` own URL matching, params/search validation, capability guards, and route composition. Feature pages own rendered behavior; see [`src/routes/README.md`](src/routes/README.md).
- `src/routeTree.gen.ts` and `src/paraglide/` are generated. Never edit them by hand; regenerate through existing tooling when their sources change.

Keep CSS tokens and visual contracts aligned with [`DESIGN.md`](DESIGN.md). Frontend state, routing, accessibility, and UI composition guidance lives in [`docs/contributing/frontend.md`](../docs/contributing/frontend.md). Repository test boundaries and fixture policy live in [`test/README.md`](../test/README.md); browser evidence and Storybook snapshot boundaries live in [`docs/contributing/e2e-testing.md`](../docs/contributing/e2e-testing.md).

## Commands

Run from `client/` unless command says otherwise:

```sh
bun run dev          # Vite development server
bun run build        # Vite production build plus TypeScript build
bun run lint         # Oxc lint
bun run test         # Explicitly runs ./test; root bunfig otherwise discovers root test/
bun run storybook    # Storybook development server on port 6006
bun run snapshot:test
bun run snapshot:docker
```

`bun run test` is the client package entry point and expands to `bun test ./test`, so it does not depend on root `bunfig.toml` discovery. Run one focused client test with `bun test ./test/<name>.test.ts` (or `.test.tsx`). `snapshot:test` starts Storybook through `client/playwright.config.ts`; use `snapshot:docker` for the pinned snapshot environment described in [`docs/contributing/e2e-testing.md`](../docs/contributing/e2e-testing.md).
