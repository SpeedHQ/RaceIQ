# Stories

`src/stories/` owns Storybook stories, deterministic story fixtures, snapshot specifications, and snapshot-only helpers. Stories exercise reusable UI and feature states in isolation; they are not route or native telemetry coverage.

## Fixture rules

- Use small, deterministic fixture data with explicit game/session/lap identity. Prefer existing fixture builders and fake data helpers over network calls, current time, random values, or a live game.
- Keep fixture setup in the story or a clearly owned story helper. Do not import production test state, user data, or generated output into a story.
- A story should expose one meaningful visual or interaction contract. Keep controls, labels, loading/error/empty states, and responsive variants explicit when they are part of that contract.

Snapshot specs use `client/playwright.config.ts`: test files end in `.snapshot.ts`, run with one worker, and write image baselines/results under `src/stories/__snapshots__/`. Review intentional visual changes; do not hand-edit PNGs or update baselines from an arbitrary environment. Use the pinned snapshot process for canonical baseline generation.

## Commands

From `client/`:

```sh
bun run storybook
bun run snapshot:test
bun run snapshot:docker
```

`storybook` serves stories on port 6006. `snapshot:test` runs Playwright against the configured Storybook server. `snapshot:docker` runs the repository's pinned snapshot wrapper. For semantic browser workflows, route coverage, and limits of visual evidence, use [`docs/contributing/e2e-testing.md`](../../../docs/contributing/e2e-testing.md).
