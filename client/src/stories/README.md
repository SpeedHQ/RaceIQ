# Stories

`src/stories/` owns Storybook stories, deterministic story fixtures, snapshot specifications, and snapshot-only helpers. Stories exercise reusable UI and feature states in isolation; they are not route or native telemetry coverage.

## Fixture rules

- Use small, deterministic fixture data with explicit game/session/lap identity. Prefer existing fixture builders and fake data helpers over network calls, current time, random values, or a live game.
- Keep fixture setup in the story or a clearly owned story helper. Do not import production test state, user data, or generated output into a story.
- A story should expose one meaningful visual or interaction contract. Keep controls, labels, loading/error/empty states, and responsive variants explicit when they are part of that contract.

Snapshot specs use `client/playwright.config.ts`: test files end in `.snapshot.ts`, run with one worker, and write ignored render output under `src/stories/__snapshots__/`. CI renders the base and PR revisions on the same runner and compares those outputs directly.

## Commands

From `client/`:

```sh
bun run storybook
bun run snapshot:test
bun run snapshot:compare
bun run snapshot:test:docker
```

`snapshot:test` generates ignored images; it does not compare revisions. `snapshot:compare` renders `origin/main` and the current worktree, then writes visual differences to `.ui-diff/report/index.html`. It needs Git, installed dependencies, Node.js, and Playwright Chromium. No checked-in baselines required; direct `playwright test` without `--update-snapshots` fails when snapshots are absent. `snapshot:test:docker` renders in the pinned container. For semantic browser workflows, route coverage, and limits of visual evidence, use [`docs/contributing/e2e-testing.md`](../../../docs/contributing/e2e-testing.md).
