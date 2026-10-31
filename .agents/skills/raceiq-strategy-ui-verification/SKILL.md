---
name: raceiq-strategy-ui-verification
description: "Verify RaceIQ strategy UI changes with compiled isolated E2E, native telemetry fixtures, multi-session evidence, and responsive checks."
---

# RaceIQ strategy UI verification

Use for pit estimates, saved-plan generation, and stint-trend UI changes. Read current root project instructions and relevant contracts first; verify paths/scripts against the checkout.

## Runnable gates

- `bun run typecheck`
- `bun run build:browser` produces the compiled application required by `StrategyRuntime`.
- Run `bun run --cwd packages/race-strategy lint` before E2E: the feature typecheck does not cover every Playwright spec, so duplicate declarations can otherwise escape until test collection.
- `bun run i18n:check-keys` catches malformed locale JSON and missing keys before Paraglide/build work.
- Run feature E2E through its package script, for example:
  ```sh
  bun run --cwd packages/race-strategy test:e2e stint-strategy.spec.ts race-plan.spec.ts --grep 'session Overview|full-stint|E2/E5|E4 plots|E6 real|G0 generator|G1|A6 Forza' --retries=0
  ```
  Check current scenario names before copying selectors. Root `test:e2e` selects different projects; the feature script selects `race-strategy` and isolated compiled runtimes.
- Release-note test currently lives at `packages/tooling-release/test/changelog.test.ts`.

## Native source fixture constraints

`packages/race-strategy/test/e2e/native-source.ts` drives actual Forza UDP packets through production ingestion. Native fixtures provide fractional fuel and wheel wear but do not supply tire compounds. Completed stints can correctly remain unusable for automatic generation despite measured rates and PI.

Do not relax production eligibility for fixtures. To exercise ready evidence, retain native measured rates/identity, stop the runner-owned isolated runtime, add registry-supported compound metadata only to persisted stint payloads, restart, then validate real API/UI. Existing tests demonstrate `runtime.databaseStatement`. Never mutate user data or add fake production fallbacks. Float32-derived rates need numeric tolerance, including reserve subtraction.

A route with `?sessionId=<id>` already opens the generator. Do not click an unscoped Generate action afterward: page action and submit button both exist. Derive admitted sample counts from parsed evidence, not emitted lap counts.

Same-car timestamp/lap rewinds can create new stints within the same session. Do not assume multiple runs imply multiple sessions; assert distinct persisted session IDs. Native car-change transitions must be admitted before measuring the next run; reuse `primeNativeRun` to wait for matching current identity and stable packet-rate windows rather than relying on one `laps: []` packet.

## Isolated database fixture lifecycle

- `StrategyRuntime.start` initializes dashboard access; calling start again on an already configured fixture fails `already_configured`. Reuse its runtime object's `restart`, or create a fresh isolated directory containing `test-data` in its path.
- For seeded API matrices, initialize then stop the runtime before seeding. Seed session/lap/stint rows while stopped; restart once for real endpoint assertions. Running startup maintenance can delete an empty newly inserted session between separate fixture statements, producing foreign-key failures.
- Give each seeded session and its anchor lap the same explicit `created_at`. Boot reconciliation can derive session timestamps from lap timestamps, otherwise destroying the intended recent-session ordering.
- Keep foreign keys enabled. Fixture SQLite connections use `PRAGMA busy_timeout=5000` to coordinate with actual app writes. Do not disable constraints or retry whole tests to hide races.
- Storage-read errors can be injected by temporarily renaming a runner-owned table, asserting the real API's 503 storage response, and restoring the table in `finally`. Do not mistake a storage failure for empty evidence.

## UI regression checks

- Track/car catalogues must remain selectable without session history. Verify named real options and explicit placeholders separately from measured-history availability.
- Give catalogue selects concise explicit accessible names. An implicit wrapping label can otherwise include hundreds of option names and make unrelated substring label queries ambiguous.
- Query chart points by `[data-lap-id]` or button role, not generic `circle`: hit targets and markers are separate SVG elements.
- Assert linked selection with `aria-pressed`, not marker radius.
- Measure actual SVG scale-adjusted label size and point bounds at desktop/mobile widths; assert no document overflow. Local plot scrolling is intentional.
- Native closed `<details>` preserves DOM text. Use locator visibility assertions; `toContainText` and homemade `getClientRects` checks do not prove disclosure visibility.
- Compare selectors are absent for one stint; ingest a second before testing selection.
- Preserve selected readout while moving points to controls. Clearing selection on blur can remove the readout on mouse-down and move a checkbox before mouse-up.
- Readout metric cells exclude lap identity/thermal state, which live in its heading. Match a plotted point to API evidence by lapId, not the first API row.
- Compare semantic cell values across interactions; do not mix innerText snapshots with textContent assertions.
- F1's Strategies route may be deliberately hidden. Check current route feature guards before choosing an E2E surface; never re-enable a hidden game just to make a test pass. Supported Forza scenarios must assert refueling-per-stop semantics, not F1's single initial fuel budget.

Reuse passing gates only while relevant inputs remain unchanged. Record exact final passing scenario scopes, including corrected focused runs; never describe intermediate failures as passes.
