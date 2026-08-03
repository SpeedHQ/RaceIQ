# Platform

Cross-domain runtime and transport conventions.

## Layout

- `http/` — reusable route parameter/query schemas with stable transformed output keys.
- `i18n/` — canonical locale registry synchronized with client inlang configuration.
- `runtime/` — source and compiled data roots for checked-in assets and game catalogs.

## Boundary

HTTP and locale leaves are browser-safe. Runtime path resolution is Node-only and must not be imported by client modules. Domain code imports explicit platform leaves; platform code must not depend on application routes, components, or database state.
