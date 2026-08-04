# Frontend Development

RaceIQ frontend uses React, TanStack Router, TanStack Query, Zustand, Tailwind CSS, and shared Base UI/shadcn primitives in `client/src/components/ui/`.

## State and data boundaries

Server owns telemetry-domain computation and authoritative session state: lap detection, sector timing, pit estimates, fuel and tire projections, corner processing, and race results. Live UI receives those results through `client/src/stores/telemetry.ts` and renders them.

Component-local state is valid for presentation behavior such as dialogs, tabs, temporary selection, animation history, and responsive layout. Query-derived display metadata is also valid. Do not open component-owned WebSocket connections or reimplement server telemetry calculations in React.

Use typed Hono RPC through `client/src/lib/rpc.ts` for API calls. Use TanStack Query for server state and Zustand for live telemetry/client-wide presentation state.

## Feature modules and imports

Feature pages and their local presentation, hooks, helpers, and types live together under `client/src/components/<feature>/`. Cross-feature code belongs in `client/src/hooks/`, `client/src/lib/`, `client/src/stores/`, or `client/src/data/` only after it has multiple real consumers.

- Import directly from the owning module. Do not add barrel files, compatibility exports, or old-path shims.
- Use `@/` imports across feature boundaries and relative imports within one feature.
- Split page orchestration from cohesive tables, panels, dialogs, canvas renderers, state hooks, and pure helpers before a module becomes a mega file.
- Keep route files thin: URL validation and capability guards belong in `client/src/routes/`; rendered behavior belongs in feature modules.
- Follow package boundaries in [`client/README.md`](../../client/README.md), [`client/src/components/README.md`](../../client/src/components/README.md), and [`client/src/routes/README.md`](../../client/src/routes/README.md).

## Shared UI primitives

Start with an existing primitive in `client/src/components/ui/`. Add or extend a primitive only when at least two consumers share a stable interaction or visual contract.

- Prefer composition over feature-specific wrappers.
- Keep domain behavior in feature components.
- Keep charts, telemetry diagrams, and genuinely one-off layouts feature-owned.
- New tables use shared table primitives unless virtualization or canvas rendering requires another implementation.
- Icon-only actions require accessible labels.
- Preserve keyboard behavior, focus styles, localization, and responsive layout.
- Complete migrations cleanly; do not leave compatibility aliases or parallel primitives.

## Styling ownership

Shared primitives own their reusable appearance through semantic variants and sizes. Variant names describe intent, not Tailwind fragments.

Primitive-owned styling includes color, border, radius, padding, typography, fixed control geometry, focus/hover behavior, and component state. Consumer `className` remains for composition: outer spacing, width imposed by a parent layout, grid/flex placement, responsive arrangement, positioning, and feature-specific CSS-variable styling.

Do not add a one-off variant to hide one consumer's incidental layout. A new variant must represent a stable component-wide contract or have multiple consumers.

## Button contract

`Button` defaults to `type="button"`. Omit `type` for normal actions; preserve explicit `type="submit"` and `type="reset"` for form semantics.

Use `variant` and `size` for reusable appearance. Use `className` only for surrounding layout or feature-specific state not owned by the primitive. Repeated visual treatments become semantic variants instead of copied class strings.

## Routing contract

Shared page families use dynamic `/$gameid` routes where behavior differs only by game identity, route prefix, search validation, or a thin wrapper. Keep explicit routes where implementation differs materially, including live dashboards, car details, game index/layout routes, AC Evo raw data, and game-specific setup flows.

Resolve identity through registered game adapters. Valid public prefixes are `/fm23`, `/f125`, `/acc`, `/ac-evo`, and `/iracing`; unknown prefixes are rejected and never fall back to Forza. `client/src/lib/game-routes.ts` owns navigation support for Driver, Experiments, Raw, and Setups; shared Driver and Experiments routes enforce that same table. See [game feature coverage](../reference/game-feature-coverage.md) for current cross-game gaps.

Shared search validators accept only finite numeric values and preserve established query keys.

## Review checklist

- Reused existing shared primitive or justified a new stable contract.
- Kept appearance in primitive variants and composition in consumers.
- Preserved explicit form button semantics.
- Kept server telemetry logic out of React components.
- Resolved game and feature support through adapter metadata.
- Preserved accessibility, localization, responsive behavior, and public URLs.
