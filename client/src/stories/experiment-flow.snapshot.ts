import { expect, test } from "@playwright/test";

/**
 * Render smoke-test for the experiment flow stories (list → workspace →
 * review, setup and driving variants).
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
  expectText: string;
  /** Text that must NOT appear — the error/empty states these screens fall to. */
  forbidText?: string[];
}

const stories: StoryCase[] = [
  {
    name: "list (both variants)",
    id: "dashboards-experiments-flow--list-both-variants",
    expectText: "Spa — rear stability on entry",
    forbidText: ["No experiments yet"],
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
    name: "workspace (setup)",
    id: "dashboards-experiments-flow--workspace-setup",
    expectText: "Softer rear ARB",
    forbidText: ["Experiment not found"],
  },
  {
    name: "workspace (driving)",
    id: "dashboards-experiments-flow--workspace-driving",
    expectText: "Trail-brake to the apex at Les Combes",
    forbidText: ["Experiment not found"],
  },
  {
    // A driving-focus experiment renders the same workspace — the difference is
    // the agent panel's name and the switcher state, not a separate route.
    name: "workspace (driving focus)",
    id: "dashboards-experiments-flow--workspace-driving-focus",
    expectText: "Driver coach",
    forbidText: ["Experiment not found"],
  },
  {
    // The review screen leads with the lap list and the driver's own words —
    // the experiment name is not on it, so assert on what actually renders.
    name: "review (setup)",
    id: "dashboards-experiments-flow--review-setup",
    expectText: "Rotates earlier, no snap. Happier.",
    forbidText: ["Experiment not found"],
  },
  {
    name: "review (driving)",
    id: "dashboards-experiments-flow--review-driving",
    expectText: "Felt slower but the car placed the same every lap.",
    forbidText: ["Experiment not found"],
  },
];

for (const story of stories) {
  test(`renders: ${story.name}`, async ({ page }) => {
    // Above Playwright's 30s default: whichever story runs first waits on
    // Storybook's cold Vite compile before it renders anything.
    test.setTimeout(120_000);

    // Only uncaught exceptions count. Storybook has no API server behind it, so
    // these screens legitimately 404 on /api/* (settings, chat history, lap
    // detail) and log a console error for each — asserting on console noise
    // would make the test fail for the one thing that is expected here.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    // Wait on rendered content, not on a class name. `dashboards.snapshot.ts`
    // waits for `[class*='border']`, which happens to hold for the panelled
    // dashboards but not for the plain table the experiment list renders.
    // Generous timeout: whichever story runs first pays Storybook's cold Vite
    // compile and sits on Storybook's spinner until it finishes.
    await page.waitForFunction(() => (document.body.innerText ?? "").trim().length > 0, null, { timeout: 90_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    await expect(page.getByText(story.expectText, { exact: false }).first()).toBeVisible();
    for (const forbidden of story.forbidText ?? []) {
      await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
    }

    expect(errors, `uncaught errors in ${story.name}:\n${errors.join("\n")}`).toEqual([]);
  });
}
