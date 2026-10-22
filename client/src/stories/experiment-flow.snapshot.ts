import { expect, test } from "./snapshot-test";
import { openStory } from "./storybook-ready";
import type { Page } from "@playwright/test";

/**
 * Render smoke-test for the experiment flow stories (list → workspace →
 * review, car- and driver-focus variants).
 *
 * Deliberately NOT a screenshot test. Add these to
 * `dashboards.snapshot.ts` when pixel comparison would add useful coverage;
 * CI renders base and PR revisions together so no committed PNG baseline is
 * required.
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

for (const story of stories) {
  test(`renders: ${story.name}`, async ({ page }) => {
    // Above Playwright's 30s default: even warm, these screens do real work
    // (seeded queries, canvas track maps) before their first text lands.
    test.setTimeout(120_000);

    // API requests use deterministic fixtures; uncaught render errors still fail.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await openStory(page, `/iframe.html?id=${story.id}&viewMode=story`, 90_000);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    const expected = Array.isArray(story.expectText) ? story.expectText : [story.expectText];
    for (const text of expected) {
      await expect
        .poll(async () =>
          page.getByText(text, { exact: false }).evaluateAll((elements) =>
            elements.some((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            }),
          ),
        )
        .toBe(true);
    }
    for (const forbidden of story.forbidText ?? []) {
      await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
    }

    expect(errors, `uncaught errors in ${story.name}:\n${errors.join("\n")}`).toEqual([]);
  });
}

function collectAnalysisRequests(page: Page) {
  const bodies: { ids: number[]; step: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/laps/aligned-telemetry") {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

test("reviews only the selected older test after returning to its setup", async ({ page }) => {
  const analysisBodies = collectAnalysisRequests(page);
  await openStory(page, "/iframe.html?id=dashboards-experiments-flow--returned-to-base-review&viewMode=story", 90_000);
  const base = page.locator("summary").filter({ has: page.getByText("Base setup", { exact: true }) });
  const newer = page.locator("summary").filter({ has: page.getByText("Softer rear ARB", { exact: true }) });
  await expect(base).toContainText("5/8");
  await expect(newer).toContainText("5/9");
  await base.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Session", exact: true })).toBeVisible();
  await expect.poll(() => analysisBodies).toEqual([{ ids: [1000, 1002, 1007, 1004, 1005], step: 1 }]);
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await newer.getByRole("button", { name: "Review", exact: true }).click();
  await expect.poll(() => analysisBodies).toEqual([
    { ids: [1000, 1002, 1007, 1004, 1005], step: 1 },
    { ids: [1100, 1102, 1107, 1108, 1104], step: 1 },
  ]);
});

for (const scenario of [
  {
    name: "test selection overrides conflicting stint and focus-lap IDs",
    story: "review-version-overrides-lap-list",
    ids: [1000, 1002, 1007, 1004, 1005],
  },
  {
    name: "explicit stint ignores duplicate, unknown, and other-experiment lap IDs",
    story: "review-explicit-lap-list",
    ids: [1002, 1004],
  },
]) {
  test(scenario.name, async ({ page }) => {
    const analysisBodies = collectAnalysisRequests(page);
    await openStory(page, `/iframe.html?id=dashboards-experiments-flow--${scenario.story}&viewMode=story`, 90_000);
    await expect(page.getByRole("button", { name: "Session", exact: true })).toBeVisible();
    await expect.poll(() => analysisBodies).toEqual([{ ids: scenario.ids, step: 1 }]);
  });
}

for (const scenario of [
  { name: "unknown test does not fall back to HEAD or explicit lap IDs", story: "review-unknown-test" },
  { name: "missing selection does not fall back to HEAD", story: "review-without-selection" },
]) {
  test(scenario.name, async ({ page }) => {
    const analysisBodies = collectAnalysisRequests(page);
    await openStory(page, `/iframe.html?id=dashboards-experiments-flow--${scenario.story}&viewMode=story`, 90_000);
    // Return to the workspace, then select a populated test. The single request
    // proves the empty review never submitted another branch's laps.
    await page.getByRole("button", { name: "Session", exact: true }).click();
    const base = page.locator("summary").filter({ has: page.getByText("Base setup", { exact: true }) });
    await expect(base).toContainText("5/8");
    await base.getByRole("button", { name: "Review", exact: true }).click();
    await expect.poll(() => analysisBodies).toEqual([{ ids: [1000, 1002, 1007, 1004, 1005], step: 1 }]);
  });
}
