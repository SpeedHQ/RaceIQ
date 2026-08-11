# Playwright test layout

`playwright/tests/` contains route-level browser specs. Config matches these domain folders; keep specs out of this directory root.

## Domains

- `fresh-install/`: onboarding and first-run behavior.
- `marketing/`: public marketing routes and visual checks.
- `responsive/`: responsive workspaces, mobile screenshot registry, and Chromium device behavior.
- `tunes/`: compiled/dev tune workflows that use dedicated tune data.
- `recording/`: hardware-oriented demo capture.
- `seeded/<domain>/`: functional workflows against committed seeded rows, grouped by product surface (`analyse`, `catalog`, `chats`, `compare`, `dash`, `dev-tools`, `driver`, `experiments`, `landing`, `live`, `raw`, `routes`, `sessions`, `settings`, and `setups`).

Use descriptive `*.spec.ts` names that state domain and behavior. Preserve existing test titles when reorganizing files; titles are CI/debugging interfaces. One cohesive domain may have multiple focused specs rather than one mega-suite.

## Helpers

Put reusable code in `tests/support/`, next to its owning domain when possible. Cross-domain browser error collection belongs in `tests/support/browser-errors.ts`. Seeded registries/types, lap selection, analyse-frame helpers, and responsive cases/assertions stay in their contracted support modules. Tune helpers stay in `tests/support/tunes.ts`. Do not create a second helper copy in a spec folder.

Seeded specs import support with `../../support/...`; imports from seeded domain folders to repository `shared`, `server`, or `test` use `../../../../...`. Non-seeded specs use support paths appropriate to their depth. Separate `client/playwright.config.ts` and Storybook snapshot tests are outside this taxonomy.

## Isolation and cleanup

Treat each spec as runnable alone under its project. Use deterministic seeded rows and test-owned disposable records. Never depend on another spec's order unless existing serial/stateful semantics require it. Restore settings, notes, imports, sessions, and deletions in `finally`; cancel destructive UI actions when testing cancellation. Keep server/data paths and generated output locations unchanged.

## Size guidance

Target source files below 225 lines. Split by cohesive route or workflow when a file grows beyond that. A larger file is acceptable only when one orchestration owns one unavoidable lifecycle and splitting would obscure setup/cleanup. Avoid speculative abstractions, duplicated selectors, compatibility shims, and undocumented manual scripts.
