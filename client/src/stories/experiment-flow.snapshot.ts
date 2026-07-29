import { expect, test } from "@playwright/test";

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
  const page = await browser.newPage();
  try {
    // The FIRST navigation after Storybook boots reliably sticks on
    // `sb-preparing-story` forever — the preview iframe asks for the story
    // before the dev server's index is ready and never retries. A reload always
    // resolves it, so retry rather than wait: waiting is what turns this into a
    // timeout blamed on whichever story sorted first.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.goto(`/iframe.html?id=${stories[0].id}&viewMode=story`, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction(() => (document.body.innerText ?? "").trim().length > 0, null, { timeout: 60_000 });
        return;
      } catch {
        // Fall through and reload. Budget is deliberately large (5 x 60s): a
        // COLD preview build genuinely takes minutes on this graph, and it is
        // paid once per run here rather than by whichever story sorts first.
      }
    }
    throw new Error("Storybook never rendered a story — is the dev server healthy?");
  } finally {
    await page.close();
  }
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

    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    // Wait on rendered content, not on a class name. `dashboards.snapshot.ts`
    // waits for `[class*='border']`, which happens to hold for the panelled
    // dashboards but not for the plain table the experiment list renders.
    // Generous timeout: whichever story runs first pays Storybook's cold Vite
    // compile and sits on Storybook's spinner until it finishes.
    await page.waitForFunction(() => (document.body.innerText ?? "").trim().length > 0, null, { timeout: 90_000 });
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
