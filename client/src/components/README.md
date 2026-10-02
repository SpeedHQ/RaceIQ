# Components

`src/components/` owns browser UI. Feature folders own cohesive page families and domain behavior; a page/container may coordinate feature hooks, stores, API calls, and child views, while presentational pieces stay beside their owning feature. Keep feature-specific charts, telemetry diagrams, layout, and interaction state in that feature.

## Dependency direction

Feature components may import shared UI primitives, direct domain hooks, `src/lib/` helpers, stores, data, and types from `shared/`. Shared modules may not import feature components. When two features need a stable interaction contract, extract the smallest reusable module into the appropriate shared location; do not create a catch-all helper for one consumer.

Use direct `@/` imports across feature boundaries. Relative imports are for files within one feature. Shared UI under `ui/` owns reusable control behavior, accessibility, semantic variants, and base styling; consumers supply layout and feature-specific composition. Preserve keyboard behavior, labels, localization, responsive behavior, and existing shadcn/Base UI composition.

Do not add barrel `index` files, compatibility exports, or deprecated aliases. During a move, update every caller to destination module directly and remove obsolete paths only after repository-wide usage checks. Persisted preferences belong in `src/lib/settings-storage.ts`, not in page modules or page re-exports.

See [`client/README.md`](../../README.md), [`docs/contributing/frontend.md`](../../../docs/contributing/frontend.md), and [`DESIGN.md`](../../DESIGN.md) for package boundaries, frontend contracts, and visual tokens. Generated `src/routeTree.gen.ts` and `src/paraglide/` are outside component ownership and must not be edited by hand.
