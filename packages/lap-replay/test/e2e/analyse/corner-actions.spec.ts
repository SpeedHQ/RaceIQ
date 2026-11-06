import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CornerAction } from "@raceiq/lap-replay/contracts";
import { getSeededLapMeta } from "../../../../../playwright/tests/support/seeded/laps";

test.describe.configure({ mode: "serial" });

type TrackSegment = {
  type: string;
  name: string;
  number?: number;
  covers?: number[];
  startFrac: number;
  endFrac: number;
};

async function configureMockAi(request: APIRequestContext): Promise<Record<string, unknown>> {
  const originalResponse = await request.get("/api/settings");
  expect(originalResponse.ok()).toBe(true);
  const original = await originalResponse.json() as Record<string, unknown>;
  const response = await request.put("/api/settings", {
    data: {
      aiProvider: "openai-compatible",
      aiModel: "mock-corner-actions",
      chatProvider: "openai-compatible",
      chatModel: "mock-corner-actions",
      localEndpoint: "http://127.0.0.1:9/v1",
    },
  });
  expect(response.ok()).toBe(true);
  return original;
}

async function cornerSegments(request: APIRequestContext, trackId: string, gameId = "fm-2023"): Promise<TrackSegment[]> {
  const response = await request.get(`/api/track-sectors/${encodeURIComponent(trackId)}?gameId=${gameId}`);
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { segments?: TrackSegment[] };
  return (payload.segments ?? []).filter((segment) => segment.type === "corner" && typeof segment.number === "number" && segment.endFrac > segment.startFrac);
}

function segmentLabel(segment: TrackSegment): string {
  return `T${segment.number}`;
}

function segmentAction(segment: TrackSegment, id: string, path: string, text: string, target: CornerAction["target"] = "solo"): CornerAction {
  const label = segmentLabel(segment);
  const start = text.indexOf(label);
  return {
    id,
    cornerKey: `t${segment.number}`,
    label: segment.name && segment.name !== label ? `${label} · ${segment.name}` : label,
    target,
    path,
    span: { start, end: start + label.length },
  };
}

function analysisFixture(segment: TrackSegment) {
  const label = segmentLabel(segment);
  const verdict = `Brake later into ${label} and release the brake smoothly.`;
  const issue = `The car is still loaded at ${label} entry.`;
  const fix = `Release the brake earlier at ${label}.`;
  const technique = `Rotate the car earlier at ${label}.`;
  return {
    verdict,
    pace: [],
    handling: [],
    corners: [{ name: label, issue, fix, severity: "moderate" }],
    technique: [{ tip: `Rotate earlier at ${label}`, detail: technique }],
    setup: [],
    actions: [
      segmentAction(segment, "a-verdict", "verdict", verdict),
      segmentAction(segment, "a-issue", "corners[0].issue", issue),
      segmentAction(segment, "a-fix", "corners[0].fix", fix),
      segmentAction(segment, "a-technique", "technique[0].tip", `Rotate earlier at ${label}`),
      // Valid action whose path is not part of this analysis: never rendered.
      segmentAction(segment, "a-orphan", "braking[0].detail", issue),
    ],
    setupProvenance: { lapId: null as number | null },
  };
}

async function mockAnalysis(
  page: Page,
  lapId: number,
  fixture: unknown,
  segments: TrackSegment[],
): Promise<void> {
  const body = {
    analysis: JSON.stringify(fixture),
    cached: true,
    cornerFracs: segments.map((segment) => ({ label: segmentLabel(segment), startFrac: segment.startFrac, endFrac: segment.endFrac })),
  };
  await page.route(`**/api/laps/${lapId}/analyse**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/status")) {
      await route.fulfill({ json: { status: "none" } });
      return;
    }
    if (request.method() === "POST" && url.searchParams.get("cacheOnly") === "true") {
      await route.fulfill({ json: body });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/laps/${lapId}/chat**`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        messages: [{
          id: "corner-action-message",
          role: "assistant",
          parts: [{ type: "text", text: JSON.stringify(fixture) }],
        }],
      },
    });
  });
}

async function openAnalysis(page: Page): Promise<void> {
  const aiToggle = page.locator('[data-panel-toggle="replay-ai-panel"]');
  if (await aiToggle.getAttribute("aria-expanded") !== "true") await aiToggle.click();
  const panel = page.locator("#replay-ai-panel");
  await expect(panel.getByRole("button").filter({ hasText: "View" }).first()).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button").filter({ hasText: "View" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

function focusMap(page: Page) {
  return page.locator("[data-corner-focus-active='true']");
}

test("solo analysis and chat actions highlight the focused segment and play entry to exit", async ({ page, request }) => {
  test.setTimeout(180_000);
  const original = await configureMockAi(request);
  const lap = await getSeededLapMeta(request, "fm-2023");
  const segments = await cornerSegments(request, lap.trackId);
  const first = segments.find((segment) => segment.number === 1) ?? segments[0]!;
  const fixture = analysisFixture(first);

  try {
    await mockAnalysis(page, lap.id, fixture, segments);
    await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
    const telemetryToggle = page.locator('[data-panel-toggle="replay-telemetry-panel"]');
    if (await telemetryToggle.getAttribute("aria-expanded") !== "true") await telemetryToggle.click();
    await expect(page.locator("#replay-telemetry-panel")).toBeVisible();
    await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("4");
    await openAnalysis(page);

    const dialog = page.getByRole("dialog");
    const action = dialog.locator('[data-corner-action="a-verdict"]');
    await expect(action).toBeVisible();
    await expect(action).toHaveText(/T1/);
    await action.click();
    await expect(focusMap(page)).toBeVisible();
    await expect(page.locator("[data-corner-focusing='true']")).toBeVisible();
    const mapStart = Number(await page.locator('[data-corner-focus-side="a"]').first().getAttribute("data-corner-focus-start"));
    expect(mapStart).toBeCloseTo(first.startFrac, 6);
    await expect(page.locator("#replay-telemetry-panel [data-corner-bands-a]")).toHaveAttribute("data-corner-bands-a", /.+/);
    const clock = page.locator("[data-spectate-playback]");
    await expect.poll(async () => Number(await clock.getAttribute("data-time"))).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => page.locator("[data-corner-focus-active='true']").count(), { timeout: 30_000 }).toBe(0);

    // Card and inline reference resolve the same segment; an action whose path
    // is absent from the analysis exposes no inline control at all.
    const inlineStartDistance = await page.locator("[data-corner-focus-label]").getAttribute("data-corner-focus-distance-start");
    expect(inlineStartDistance).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-corner-focus-label]")).toHaveCount(0);
    await openAnalysis(page);
    const cardDialog = page.getByRole("dialog");
    await expect(cardDialog.locator('[data-corner-action="a-orphan"]')).toHaveCount(0);
    await cardDialog.locator("[data-corner-card]").first().click();
    await expect(focusMap(page)).toBeVisible();
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-label", /T1/);
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-distance-start", inlineStartDistance!);
    await cardDialog.getByRole("button", { name: "Close" }).click();
    await expect(cardDialog).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(focusMap(page)).toHaveCount(0);

    // Chat history is a schema-shaped analysis response; the inline action is clickable there too.
    const chatAction = page.locator("#replay-ai-panel [data-corner-action='a-verdict']").first();
    await expect(chatAction).toBeVisible();
    await chatAction.click({ modifiers: ["Shift"] });
    await expect(focusMap(page)).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(focusMap(page)).toBeVisible();

    // Escape clears focus. P2 (whether it also pauses) is deliberately not asserted.
    await page.keyboard.press("Escape");
    await expect(focusMap(page)).toHaveCount(0);
    await expect(page.locator("[data-corner-focusing='true']")).toHaveCount(0);

    // The same inline reference is keyboard-operable inside the chat panel.
    await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("1");
    const chatKeyboardAction = page.locator("#replay-ai-panel [data-corner-action='a-verdict']").first();
    await chatKeyboardAction.focus();
    await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-corner-action"))).toBe("a-verdict");
    await page.keyboard.press("Enter");
    await expect(focusMap(page)).toBeVisible();
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-label", /T1/);
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-distance-start", inlineStartDistance!);
    await page.keyboard.press("Escape");
    await expect(focusMap(page)).toHaveCount(0);

    await openAnalysis(page);
    const enterDialog = page.getByRole("dialog");
    await enterDialog.locator('[data-corner-action="a-verdict"]').focus();
    const plainFocusStartedAt = Date.now();
    await page.keyboard.press("Enter");
    await expect(focusMap(page)).toBeVisible();
    await enterDialog.getByRole("button", { name: "Close" }).click();
    await expect(enterDialog).toHaveCount(0);
    await expect.poll(async () => page.locator("[data-corner-focus-active='true']").count(), { timeout: 30_000 }).toBe(0);
    const plainFocusMs = Date.now() - plainFocusStartedAt;
    await page.keyboard.press("Escape");
    await expect(focusMap(page)).toHaveCount(0);

    await openAnalysis(page);
    const reopened = page.getByRole("dialog");
    const keyboardAction = reopened.locator('[data-corner-action="a-verdict"]');
    await keyboardAction.focus();
    await page.keyboard.down("Shift");
    try {
      await page.keyboard.press("Space");
      await expect(focusMap(page)).toBeVisible();
      // Native Shift+Space must carry shiftKey: the loop survives its own exit.
      await page.waitForTimeout(plainFocusMs + 700);
      await expect(focusMap(page)).toBeVisible();
    } finally {
      await page.keyboard.up("Shift");
    }
    await reopened.getByRole("button", { name: "Close" }).click();
    await page.keyboard.press("Escape");
    await expect(focusMap(page)).toHaveCount(0);
  } finally {
    await request.put("/api/settings", { data: original });
  }
});

test("Space on the focused chat reference focuses the corner instead of toggling playback", async ({ page, request }) => {
  test.setTimeout(180_000);
  const original = await configureMockAi(request);
  const lap = await getSeededLapMeta(request, "fm-2023");
  const segments = await cornerSegments(request, lap.trackId);
  const first = segments.find((segment) => segment.number === 1) ?? segments[0]!;
  const fixture = analysisFixture(first);
  try {
    await mockAnalysis(page, lap.id, fixture, segments);
    await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
    const aiToggle = page.locator('[data-panel-toggle="replay-ai-panel"]');
    if (await aiToggle.getAttribute("aria-expanded") !== "true") await aiToggle.click();
    await page.getByRole("combobox", { name: "Playback speed", exact: true }).selectOption("1");
    const clock = page.locator("[data-spectate-playback]");

    // Space on an empty surface keeps driving replay playback, both ways.
    await page.locator("section[data-focus-mode]").click({ position: { x: 4, y: 4 } });
    const emptyPlaying = await clock.getAttribute("data-playing");
    await page.keyboard.press("Space");
    await expect.poll(async () => clock.getAttribute("data-playing")).not.toBe(emptyPlaying);
    await page.keyboard.press("Space");
    await expect.poll(async () => clock.getAttribute("data-playing")).toBe(emptyPlaying);

    const chatAction = page.locator("#replay-ai-panel [data-corner-action='a-verdict']").first();
    await expect(chatAction).toBeVisible({ timeout: 30_000 });
    await chatAction.focus();
    await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-corner-action"))).toBe("a-verdict");

    await page.keyboard.press("Space");
    // Native activation wins: the reference keeps focus and focuses the corner
    // instead of the replay shortcut toggling playback.
    await expect(focusMap(page)).toBeVisible();
    await expect.poll(async () => Number(await page.locator('[data-corner-focus-side="a"]').first().getAttribute("data-corner-focus-start"))).toBeCloseTo(first.startFrac, 6);
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-label", /T1/);
    await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-corner-action"))).toBe("a-verdict");
    await page.keyboard.press("Escape");
    await expect(focusMap(page)).toHaveCount(0);
  } finally {
    await request.put("/api/settings", { data: original });
  }
});

test("stale analysis from another lap exposes no action and cannot seek", async ({ page, request }) => {
  test.setTimeout(180_000);
  const original = await configureMockAi(request);
  const lap = await getSeededLapMeta(request, "fm-2023");
  const segments = await cornerSegments(request, lap.trackId);
  const segment = segments[0]!;
  const fixture = analysisFixture(segment);
  fixture.setupProvenance = { lapId: lap.id + 10_000 };
  try {
    await mockAnalysis(page, lap.id, fixture, segments);
    await page.goto(`/fm23/sessions/${lap.sessionId}/replay/${lap.id}`);
    await openAnalysis(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-corner-action]")).toHaveCount(0);
    await expect(dialog.locator("[data-corner-card]")).toHaveCount(0);
    await expect(page.locator("[data-corner-focus-active='true']")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();
  } finally {
    await request.put("/api/settings", { data: original });
  }
});

test("T1 and T10 focus their own bounds and unknown actions do not seek", async ({ page, request }) => {
  test.setTimeout(180_000);
  const original = await configureMockAi(request);
  const gameId = "f1-2025";
  const prefix = "f125";
  const lap = await getSeededLapMeta(request, gameId);
  const segments = await cornerSegments(request, lap.trackId, gameId);
  const first = segments.find((segment) => segment.number === 1);
  const tenth = segments.find((segment) => segment.number === 10);
  test.skip(!first || !tenth, "seeded F1 track needs numbered T1 and T10");
  const fixture = analysisFixture(first!);
  fixture.verdict = "Brake later into T1 and T10.";
  const againstAnd = fixture.verdict.indexOf("and");
  const stranger = {
    ...segmentAction(first!, "a-stranger", "verdict", fixture.verdict),
    cornerKey: "turn:999",
    label: "T99",
    span: { start: againstAnd, end: againstAnd + 3 },
  };
  fixture.actions = [
    segmentAction(first!, "a-verdict", "verdict", fixture.verdict),
    segmentAction(tenth!, "a-tenth", "verdict", fixture.verdict),
    stranger,
  ];
  try {
    await mockAnalysis(page, lap.id, fixture, segments);
    await page.goto(`/${prefix}/sessions/${lap.sessionId}/replay/${lap.id}`);
    await openAnalysis(page);
    const dialog = page.getByRole("dialog");
    await dialog.locator('[data-corner-action="a-verdict"]').click();
    await expect.poll(async () => Number(await page.locator('[data-corner-focus-side="a"]').first().getAttribute("data-corner-focus-start"))).toBeCloseTo(first!.startFrac, 6);
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-label", /T1/);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-corner-focus-active='true']")).toHaveCount(0);
    await openAnalysis(page);
    let reopened = page.getByRole("dialog");
    await reopened.locator('[data-corner-action="a-tenth"]').click();
    await expect.poll(async () => Number(await page.locator('[data-corner-focus-side="a"]').first().getAttribute("data-corner-focus-start"))).toBeCloseTo(tenth!.startFrac, 6);
    await expect(page.locator("[data-corner-focus-label]")).toHaveAttribute("data-corner-focus-label", /T10/);
    await reopened.getByRole("button", { name: "Close" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-corner-focus-active='true']")).toHaveCount(0);
    await openAnalysis(page);
    reopened = page.getByRole("dialog");
    await reopened.locator('[data-corner-action="a-stranger"]').click();
    await expect(page.locator("[data-corner-focus-active='true']")).toHaveCount(0);
    await reopened.getByRole("button", { name: "Close" }).click();
  } finally {
    await request.put("/api/settings", { data: original });
  }
});
