import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CornerAction } from "@raceiq/lap-replay/contracts";
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers";

test.describe.configure({ mode: "serial" });

type TrackSegment = {
  type: string;
  name: string;
  number?: number;
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

async function cornerSegments(request: APIRequestContext, trackId: string): Promise<TrackSegment[]> {
  const response = await request.get(`/api/track-sectors/${encodeURIComponent(trackId)}?gameId=fm-2023`);
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { segments?: TrackSegment[] };
  return (payload.segments ?? []).filter((segment) => segment.type === "corner" && typeof segment.number === "number" && segment.endFrac > segment.startFrac);
}

function label(segment: TrackSegment): string {
  return `T${segment.number}`;
}

function action(segment: TrackSegment, id: string, path: string, text: string, target: CornerAction["target"]): CornerAction {
  const start = text.indexOf(label(segment));
  return {
    id,
    cornerKey: `t${segment.number}`,
    label: segment.name && segment.name !== label(segment) ? `${label(segment)} · ${segment.name}` : label(segment),
    target,
    path,
    span: { start, end: start + label(segment).length },
  };
}

function fixture(segment: TrackSegment, lapId: number, target: "A" | "B") {
  const corner = label(segment);
  const verdict = `Brake later into ${corner} on lap ${target}.`;
  const fix = `Release the brake earlier at ${corner}.`;
  return {
    verdict,
    pace: [],
    handling: [],
    corners: [{ name: corner, issue: `The car is loaded at ${corner} entry.`, fix, severity: "moderate" }],
    technique: [],
    setup: [],
    actions: [
      action(segment, `a-verdict-${target}`, "verdict", verdict, target),
      action(segment, `a-fix-${target}`, "corners[0].fix", fix, "linked"),
    ],
    setupProvenance: { lapId },
  };
}

async function mock(page: Page, lapId: number, fixtureBody: unknown, segments: TrackSegment[]) {
  const body = {
    analysis: JSON.stringify(fixtureBody),
    cached: true,
    cornerFracs: segments.map((segment) => ({ label: label(segment), startFrac: segment.startFrac, endFrac: segment.endFrac })),
  };
  await page.route(`**/api/laps/${lapId}/analyse**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: { status: "none" } });
    if (request.method() === "POST" && url.searchParams.get("cacheOnly") === "true") return route.fulfill({ json: body });
    return route.continue();
  });
  await page.route(`**/api/laps/${lapId}/chat**`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { messages: [] } });
    return route.continue();
  });
}

async function openLapView(page: Page, index: number): Promise<void> {
  const toggle = page.locator('[data-panel-toggle="spectate-ai-panel"]');
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const panel = page.locator("#spectate-ai-panel");
  const buttons = panel.getByRole("button").filter({ hasText: "View" });
  await expect(buttons.nth(index)).toBeVisible({ timeout: 30_000 });
  await buttons.nth(index).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("compare linked A/B focus highlights both bounds and targets each lap", async ({ page, request }) => {
  test.setTimeout(220_000);
  const original = await configureMockAi(request);
  const pair = await getDistinctPair(request, "fm-2023");
  const segments = await cornerSegments(request, pair.lapA.trackId);
  const corner = segments[0]!;
  try {
    await mock(page, pair.lapA.id, fixture(corner, pair.lapA.id, "A"), segments);
    await mock(page, pair.lapB.id, fixture(corner, pair.lapB.id, "B"), segments);
    await page.goto(`/fm23/compare?${compareQuery(pair)}&view=spectate&ai=1`);
    await expect(page.locator("[data-spectate-workspace]")).toBeVisible();
    const telemetryToggle = page.locator('[data-panel-toggle="spectate-telemetry-panel"]');
    if (await telemetryToggle.getAttribute("aria-expanded") !== "true") await telemetryToggle.click();
    await expect(page.locator("#spectate-telemetry-panel")).toBeVisible();
    await openLapView(page, 0);
    let dialog = page.getByRole("dialog");
    await dialog.locator('[data-corner-action="a-verdict-A"]').click();
    await expect(page.locator("[data-corner-focus-active='true']")).toBeVisible();
    await expect(page.locator('[data-corner-focus-side="a"]').first()).toHaveAttribute("data-corner-focus-start", String(corner.startFrac));
    await expect(page.locator('[data-corner-focus-side="b"]')).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-corner-focus-active='true']")).toHaveCount(0);

    await openLapView(page, 0);
    dialog = page.getByRole("dialog");
    await dialog.locator('[data-corner-action="a-fix-A"]').click();
    await expect(page.locator('[data-corner-focus-active="true"]')).toBeVisible();
    await expect(page.locator('[data-corner-focus-side="a"]')).toHaveCount(1);
    await expect(page.locator('[data-corner-focus-side="b"]')).toHaveCount(1);
    const telemetryRoot = page.locator("#spectate-telemetry-panel [data-corner-focusing]").first();
    await expect(telemetryRoot).toHaveAttribute("data-corner-focusing", "true");
    await expect(telemetryRoot).toHaveAttribute("data-corner-bands-a", /.+/);
    await expect(telemetryRoot).toHaveAttribute("data-corner-bands-b", /.+/);
    expect(await telemetryRoot.getAttribute("data-corner-bands-a")).not.toBe(
      await telemetryRoot.getAttribute("data-corner-bands-b"),
    );
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-corner-focus-active='true']")).toHaveCount(0);

    await openLapView(page, 1);
    dialog = page.getByRole("dialog");
    await dialog.locator('[data-corner-action="a-verdict-B"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-corner-focus-side="b"]').first()).toHaveAttribute("data-corner-focus-start", String(corner.startFrac));
    await expect(page.locator('[data-corner-focus-side="a"]')).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.keyboard.press("Escape");
  } finally {
    await request.put("/api/settings", { data: original });
  }
});
