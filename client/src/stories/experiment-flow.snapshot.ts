import { expect, test } from "@playwright/test";
import { openStory, warmStorybook } from "./storybook-ready";

/**
 * Render smoke-test for the experiment flow stories (list → workspace →
 * review, car- and driver-focus variants).
 *
 * Deliberately NOT a screenshot test. The committed PNG baselines in
 * `__snapshots__` are generated in Docker (`bun run snapshot:docker`) so they
 * are reproducible across machines; baselines produced on a dev box render
 * with different font hinting and would fail CI for reasons that have nothing
 * to do with the UI. Add these to `dashboards.snapshot.ts` if you want pixel
 * baselines — from Docker.
 *
 * What this does catch is the failure mode a `tsc` pass cannot: a story that
 * compiles but throws on mount, or renders its error/empty state because the
 * seeded query keys drifted from the ones the hooks actually read. A story
 * silently showing "Experiment not found" still typechecks.
 */

interface StoryCase {
  name: string;
  id: string;
  /** Text that must be on screen for the story to be considered rendered. */
  expectText: string | string[];
  /** Text that must NOT appear — the error/empty states these screens fall to. */
  forbidText?: string[];
}

const stories: StoryCase[] = [
  {
    name: "list (both variants)",
    id: "dashboards-experiments-flow--list-both-variants",
    expectText: ["Spa — rear stability on entry", "Focus"],
    forbidText: ["No experiments yet", "Varying"],
  },
  {
    name: "list (empty)",
    id: "dashboards-experiments-flow--list-empty",
    expectText: "No experiments yet",
  },
  {
    // The story's play function drops a setup file into the new-experiment
    // modal. `Found in Setups` is the pinned card's status pill; the forbidden
    // strings are the two prose lines it replaced, which used to appear
    // together and contradict each other.
    name: "new experiment (dropped setup card)",
    id: "dashboards-experiments-flow--new-experiment-dropped-setup",
    expectText: "Found in Setups",
    forbidText: ["is already in your Setups folder", "isn't in your Setups folder yet"],
  },
  {
    name: "workspace (car focus)",
    id: "dashboards-experiments-flow--workspace-car-focus",
    expectText: ["Softer rear ARB", "Race engineer"],
    forbidText: ["Experiment not found"],
  },
  {
    // A driver-focus experiment renders the same workspace — the difference is
    // the agent panel's name and the switcher state, not a separate route. So
    // assert both: that the drill arms render, and that the panel is the coach
    // rather than the engineer.
    name: "workspace (driver focus)",
    id: "dashboards-experiments-flow--workspace-driver-focus",
    expectText: ["Trail-brake to the apex at Les Combes", "Driver coach"],
    forbidText: ["Experiment not found", "Race engineer"],
  },
  {
    // The review screen leads with the lap list and the driver's own words —
    // the experiment name is not on it, so assert on what actually renders.
    name: "review (car focus)",
    id: "dashboards-experiments-flow--review-car-focus",
    expectText: "Rotates earlier, no snap. Happier.",
    forbidText: ["Experiment not found"],
  },
  {
    name: "review (driver focus)",
    id: "dashboards-experiments-flow--review-driver-focus",
    expectText: "Felt slower but the car placed the same every lap.",
    forbidText: ["Experiment not found"],
  },
];

/**
 * Pay Storybook's cold Vite compile ONCE, here, instead of charging it to
 * whichever test happens to run first.
 *
 * Without this the first story in the file has to both compile the module graph
 * and render inside its own wait, so a heavier import graph pushes that one test
 * past its timeout while every later story passes — a failure that follows load
 * order rather than the story, and looks exactly like a regression in whatever
 * story sorted first.
 */
test.beforeAll(async ({ browser }) => {
  test.setTimeout(360_000);
  await warmStorybook(browser, `/iframe.html?id=${stories[0].id}&viewMode=story`, { attempts: 18, attemptTimeoutMs: 15_000 });
});

for (const story of stories) {
  test(`renders: ${story.name}`, async ({ page }) => {
    // Above Playwright's 30s default: even warm, these screens do real work
    // (seeded queries, canvas track maps) before their first text lands.
    test.setTimeout(120_000);

    // Only uncaught exceptions count. Storybook has no API server behind it, so
    // these screens legitimately 404 on /api/* (settings, chat history, lap
    // detail) and log a console error for each — asserting on console noise
    // would make the test fail for the one thing that is expected here.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await openStory(page, `/iframe.html?id=${story.id}&viewMode=story`, 90_000);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    const expected = Array.isArray(story.expectText) ? story.expectText : [story.expectText];
    for (const text of expected) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    }
    for (const forbidden of story.forbidText ?? []) {
      await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
    }

    expect(errors, `uncaught errors in ${story.name}:\n${errors.join("\n")}`).toEqual([]);
  });
}
