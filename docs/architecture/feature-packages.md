# Feature packages

## Status and purpose

Agreed convention for new and extracted product features. `@raceiq/tracks-catalogue`, `@raceiq/cars-catalogue`, and `@raceiq/race-strategy` implement it; unrelated features are not automatically migrated.

A feature owns its UI, server behavior, feature-local contracts and tests in **one workspace**. The application composes features; it does not own their implementations. This boundary supports feature-level Turbo impact selection without splitting every feature into separate UI/server/test packages.

Decision: [Feature-owned E2E boundaries](../adr/0015-e2e-aware-package-extraction.md). Extractions: [catalogue contract and verification](../../advisor-plans/catalogues-contract.md), [race strategy contract and verification](../../advisor-plans/race-strategy-contract.md). Dashboard extraction and the broader selective-CI rollout remain deferred.

## Layout

Use one `package.json` and one `turbo.json` per feature:

```text
packages/tracks-catalogue/
  package.json
  turbo.json
  ui/
    index.ts
  server/
    index.ts
  contracts/
    index.ts
  test/
    unit/
    integration/
    e2e/
```

- `ui/`: feature components, presentation state and feature-owned query hooks.
- `server/`: feature routes, domain/application services and feature-owned persistence queries or background processing.
- `contracts/`: feature-owned API schemas/types, events and typed host bindings that either side can consume safely.
- `test/`: tests owned by the feature, including browser E2Es against the real application. Keep suite manifests required by the existing test-owner runner at the feature's `test/` root when introducing Bun suites.

Do not add an intermediate `src/` directory or nested workspace manifests for `ui/`, `server/` or `contracts/`. Do not create packages per page by default. Foundation packages shared by independent features remain appropriate when they have a coherent responsibility.

## Public entry points

Expose explicit source entry points, following the repository's workspace conventions. The tracks package exports:

```json
{
  "name": "@raceiq/tracks-catalogue",
  "private": true,
  "type": "module",
  "exports": {
    "./ui": "./ui/index.ts",
    "./server": "./server/index.ts",
    "./contracts": "./contracts/index.ts"
  }
}
```

This is an export example, not a complete package manifest. Declare the feature's actual dependencies and project scripts during implementation.

Client hosts import `@raceiq/tracks-catalogue/ui`; backend hosts import `@raceiq/tracks-catalogue/server`; consumers import public contracts through `@raceiq/tracks-catalogue/contracts`. Cars use the same three public subpaths. Do not expose a mixed root barrel, export everything through wildcards, or import another package's private files.

## Import and ownership rules

| Area | Allowed dependencies | Forbidden dependencies |
| --- | --- | --- |
| `contracts/` | Browser-safe schemas/types and genuinely shared contracts | Feature UI/server implementations, DB/native modules, app initialization |
| `ui/` | Feature contracts, browser-safe libraries and narrow shared UI/platform primitives | Feature server implementation, server-only transitive imports, client app composition root |
| `server/` | Feature contracts, server libraries and explicit shared persistence/runtime services | Feature UI implementation and backend app composition root |
| Tests | Real feature entry points, applicable shared harness and fixtures | Duplicate ownership, fake production fallbacks or undeclared cross-feature dependencies |

Enforce these rules with scoped UI/server TypeScript projects and static import-boundary checks, including transitive imports. Type-only imports must not create cycles or bypass authoritative contract ownership. Production browser build evidence must demonstrate that DB/native/server modules are excluded; separate exports alone are not proof.

Use static imports. Do not use dynamic imports to hide cycles, defer forbidden initialization or make an incorrect package boundary appear valid.

A feature may use another feature's explicit public contract or service when there is a genuine dependency. Declare it in the manifest, keep the graph acyclic, and include dependent feature suites in impact selection. Do not create a catch-all shared barrel that reconnects every feature.

## Shared functions across features

Shared packages are explicitly allowed when multiple features need the same function. Feature ownership does not require duplicating common behavior or making one feature depend on another merely to reuse a helper.

- Prefer an existing package with the correct responsibility, such as `@raceiq/frontend-pure` for browser-safe helpers or `@raceiq/analysis-core` for shared analysis algorithms.
- If no existing package fits, extract a small, purpose-named workspace under `packages/`. A single genuinely shared function can justify it; do not invent additional abstractions or wait for a large module.
- Move the authoritative implementation and its focused tests into the shared package; migrate all consumers. Do not retain copied implementations or feature-local forwarding shims.
- Keep the dependency direction acyclic: features depend on the shared package, not the shared package on feature implementations or app composition roots.
- UI-consumed helpers must remain browser-safe through their entire import chain. Server-only helpers may use server dependencies but must not be reachable through browser entry points.
- Each consumer declares its actual workspace dependency and imports a public export. Avoid catch-all `shared`/`utils` barrels that force unrelated features into the same dependency closure.
- Shared packages own focused unit/integration tests as appropriate. Consuming feature E2Es still prove the behavior through the real application; helpers without an application surface do not need an artificial browser E2E suite.
- A shared-function change selects every consuming feature's E2Es and relevant cross-feature gates. Non-consuming features are not selected solely because the helper is shared. Package-level dependency granularity may conservatively select more consumers; do not claim per-function precision or hide real dependencies.

During extraction, prove the helper's boundary/error behavior with focused tests, then use controlled changes to verify consumer/non-consumer selection and execute the affected real feature E2Es.


## Application composition and shared services

Keep thin route registration, boot/shutdown orchestration and host bindings in the app. The feature exports its real UI entry and typed Hono routes/factories; the host supplies existing shared concerns through explicit typed bindings where needed:

- UI: authenticated RPC, routing/navigation, game/settings context, translations and genuinely shared controls.
- Server: database executors, catalogs/registries, notifications and lifecycle registration.

Preserve Hono inferred RPC typing, shared auth/CSRF/origin middleware, API errors, nullable fields and event semantics. Do not replace typed RPC with raw fetch, unsafe casts or manually duplicated endpoint definitions to remove graph edges.

Shared DB connection ownership, embedded migrations/schema, write coordination, global WebSocket transport and process lifecycle remain platform responsibilities unless a separate decision changes their ownership. Features own their use of these services and feature-specific logic, not duplicate global instances.

Keep genuinely shared DTOs authoritative in their existing shared location. Put feature-local definitions in `contracts/`; do not copy a shared schema merely to make the directory look self-contained. Moving ownership requires migrating all callers without cycles or compatibility shims.

## Tests and Turbo selection

Each feature owns its unit, integration and E2E suites. Browser E2Es live inside the feature and exercise the **complete real compiled application**, its real server/API and affected persistence/transport integrations—not a feature-only mock server.

The catalogue and race-strategy packages register `test:e2e` for execution and `e2e:impact` for boundary validation and impact selection. `test:e2e` depends on its impact task and the shared compiled-app build. The build is an execution prerequisite, not an impact dependency.

- Changes to either `ui/` or `server/` intentionally select the feature's E2Es. One workspace means feature-level invalidation; subpath exports do not promise independent Turbo package graphs.
- Impact inputs include feature code, contracts, specs, suite manifests, fixtures, setup and actual shared dependency closure.
- Full-app build/start is an execution prerequisite, not a reason to classify every feature as changed. Keep impact selection separate from execution dependencies.
- Shared auth, root routing/composition, migrations, boot, common seed/build/harness or shared runtime changes select every actual consumer.
- Shared package dependencies remain declared even when conservative. Never delete dependencies or omit inputs to manufacture fewer selected tests.
- Unknown/unclassified impact or unavailable SCM history retains full coverage. Selection/configuration failures must never become a successful empty selection.
- Keep full-mode execution, a small real application smoke suite, and explicitly owned cross-feature journeys. Each spec has one owner; do not duplicate it in central Playwright and the feature.

Central Playwright configuration/server helpers remain shared infrastructure. Extend discovery to feature-local specs, retain setup dependencies and seeded/unseeded states, and isolate mutable databases/ports. A broad residual legacy suite may still over-select until its actual scopes are separated; report that limitation rather than claim isolation.

Do not enable E2E result caching as part of adopting this pattern. Existing test-result policies remain unchanged unless separately reviewed.

### Minimal inherited configuration

Turbo discovers workspace dependencies and uses package files as default inputs; it does not generate or continuously rewrite configuration. Keep shared harness, application-composition and infrastructure inputs in the root `turbo.json`. Feature configurations extend those arrays rather than repeat them:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "extends": ["//"],
  "tasks": {
    "transit": {
      "inputs": ["$TURBO_DEFAULT$", "!test/**"]
    },
    "e2e:impact": {
      "inputs": ["$TURBO_EXTENDS$", "$TURBO_ROOT$/client/src/features/tracks-catalogue-host.tsx"]
    }
  }
}
```

Default package inputs capture new or changed UI, server, contract and spec files without maintaining file lists. Excluding tests from dependency transit prevents an owned spec from invalidating unrelated consumers; the owner's impact task still includes its tests. The one external host-adapter input records genuine application-owned integration. Cars use their corresponding adapter. Update shared root inputs only when the actual shared boundary changes.

See Turbo's [default inputs](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks#specifying-inputs), [array inheritance](https://turborepo.dev/docs/reference/package-configurations#extending-arrays-with-turbo_extends) and [affected selection](https://turborepo.dev/docs/reference/run#--affected). This pattern was verified against the installed Turbo 2.11.7.

Package scripts invoke the existing Playwright CLI directly. Catalogue suites own distinct seeded data directories and HTTP/client/UDP ports; race-strategy scenarios launch the same compiled application with per-scenario isolated data and dynamically allocated ports. There is no additional feature E2E runner. Full browser invocations include all three projects; selective task support alone does not mean those CI jobs are skipped. Use `scripts/test/run-turbo.ts` for affected E2E selection: unavailable SCM history or changed paths outside declared workspace ownership retain full coverage.


## Adoption and review checklist

1. Define the feature's product responsibility, public operations, contract ownership and genuine cross-feature consumers. Avoid bundling unrelated pages or extracting utilities only to increase package count.
2. For cross-layer work, create separate UI/server implementation plans referencing one shared Markdown contract. Fix request/response/event semantics, errors, ownership and acceptance criteria before parallel implementation.
3. Assign one editor for the package manifest, exports, Turbo/TypeScript configuration and shared bindings. UI/server implementations can proceed in disjoint directories.
4. Migrate implementation, callers and exclusively owned tests together. Remove obsolete paths; do not land an empty scaffold or claim complete ownership while E2Es remain centrally owned.
5. Verify the actual UI/server integration, public typing, lifecycle and browser/server import boundary. Inject a forbidden UI-to-server import in an isolated worktree to prove the boundary gate rejects it; restore the boundary and verify the production browser build and real feature flow.
6. Compare full test discovery before/after: no lost or duplicate tests. Use controlled UI-only, server-only, spec-only, unrelated-feature, shared-infrastructure and missing-history changes to prove both positive and negative selection.
7. Execute selected real E2Es, a deliberately failing selected gate and final full-mode coverage. Record selected task IDs, executed suites, outcomes and actual jobs avoided. Dry-runs, static checks and mock-only tests are not runtime acceptance evidence.

A feature extraction is complete only when its code and tests are owned together, production behavior is preserved, boundaries are enforced and selection is proven. Colocation alone does not establish safe E2E skipping.

## Related documentation

- [Architecture overview](overview.md)
- [Frontend development](../contributing/frontend.md)
- [End-to-end testing](../contributing/e2e-testing.md)
- [Catalogue contract and integrated verification](../../advisor-plans/catalogues-contract.md)
- [Deferred dashboard extraction proposal](../../advisor-plans/002-e2e-extraction-contract.md)
