# Storybook Snapshot CI Speed Design

## Goal

Speed Storybook visual snapshot runs without changing committed PNG output, pinned Playwright rendering, or diff artifact behavior. Static Storybook is the default for every snapshot command: local `snapshot:test`, baseline generation, Docker, and CI.

## Architecture

`client/playwright.config.ts` owns the snapshot server lifecycle. Playwright first builds Storybook once into `storybook-static`, then starts a static server on the configured snapshot port and waits for `/index.json`. The server must honor `RACEIQ_STORYBOOK_PORT` and `RACEIQ_STORYBOOK_ROOT` so existing local and CI invocation patterns remain valid. The static server replaces the cold `storybook dev` command; snapshot tests remain serial and retain existing snapshot/result directories.

The static build is intentionally part of the Playwright `webServer` command rather than duplicated in GitHub workflows or the Docker entrypoint. This keeps all snapshot entrypoints behaviorally identical and leaves artifact collection unchanged.

## Story readiness

`openStoryForSnapshot` keeps deterministic setup and explicit readiness checks:

1. Install reduced-motion snapshot CSS before navigation.
2. Navigate to the iframe and wait for visible story-root content.
3. Await `document.fonts.ready`.
4. Require the existing theme CSS tokens.
5. Require all document images to be complete and successfully decoded.
6. Pulse the viewport to trigger ResizeObserver-backed layouts and charts.
7. Require every `[data-visual-ready]` element to have value `ready`.

Remove the full-tree geometry/computed-style/canvas data-URL signature loop. Static Storybook eliminates preview compilation races, while the explicit checks cover resources and app-owned readiness signals. Existing story-level targeted assertions remain unchanged.

Obsolete `warmStorybook` calls and cold-preview comments are removed. No readiness check is removed merely for timing.

## Error handling

Playwright's existing web-server timeout and `/index.json` readiness remain the startup failure boundary. Story navigation continues to use its current retry behavior. Resource or app readiness failures continue to fail the individual snapshot with the existing timeout, preserving diagnostics rather than silently capturing an unstable frame.

## Verification

- Run the static Storybook snapshot suite and confirm all 25 cases pass.
- Run `bun run snapshot:docker` in the pinned `mcr.microsoft.com/playwright:v1.62.0-jammy` renderer.
- Compare generated PNGs byte-for-byte with committed baselines; investigate any drift rather than changing diff thresholds.
- Record before/after wall-clock duration and report remaining bottlenecks.
- Exercise CI-equivalent `snapshot:test` to preserve result/diff artifact generation.
