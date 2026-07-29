# Consolidate Per-Game Routes Design

## Goal

Replace copied shared page routes with dynamic `/$gameid` route implementations while preserving every public URL, search parameter, game capability boundary, and unsupported-game behavior for FM23, F1 2025, ACC, AC Evo, and iRacing.

## Route classification

### Shared dynamic route families

- `sessions`
- `chats`
- `analyse`
- `driver`
- `experiments`, including list, workspace, and review routes for setup-engineer games

These routes differ only in route prefix, resolved `GameId`, search validation, or a shared wrapper.

### Explicit routes retained

- `raw`: AC Evo has a materially different implementation.
- Setup subtrees: FM23 wheel/tune pages, ACC/AC Evo import/edit/new pages, and F1 setup behavior are not one shared implementation.
- Dashboards and car-detail routes: game-specific telemetry and UI behavior remains explicit.
- Game index/layout routes: retain per-game entry behavior while shared children move under `/$gameid`.

## Architecture

The dynamic route layout resolves the URL segment through a single client route helper backed by the registered game adapters. The helper returns `GameId` only for supported route prefixes; unknown prefixes are rejected by the supported-game guard and never fall back to FM23.

Shared search validators live in a focused helper module. They normalize numeric values only when finite and preserve the existing accepted query keys. Experiment validators preserve `session=live`, numeric session/lap values, and `overview`/`sN` views.

Experiment route components derive the active `GameId` and route prefix from the dynamic layout. They pass the resolved game to existing `ExperimentList`, `ExperimentWorkspace`, and review components. Feature availability remains explicit through route metadata so iRacing receives shared pages but no setup-engineer experiment routes.

Navigation uses the same route helper and adapter metadata for shared destinations. Existing paths remain `/fm23/...`, `/f125/...`, `/acc/...`, `/ac-evo/...`, and `/iracing/...`.

## Error handling

- Unknown route prefixes produce the existing unsupported-game guard behavior.
- Missing or invalid numeric search values become `undefined` as before.
- Unsupported features are not rendered in navigation and are not routed through shared components.
- No dynamic imports are introduced.

## Testing

Add focused tests for route helper resolution, supported game IDs including iRacing, unknown IDs, numeric/search validation, session tabs, experiment search values, and feature support. Regenerate the TanStack route tree through the project generator. Verify the focused tests, client build, and full test suite; document unrelated baseline dependency failures.
