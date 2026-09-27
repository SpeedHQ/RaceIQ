import { expect, test } from "@playwright/test";
import { findTrackCarPairWithTwoLaps, getSeededLaps, lapOptionLabel } from "../seeded/compare/helpers";
import { getSeededLapTarget } from "../support/seeded/laps";
import { writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SCREENSHOT_DIR = resolve(__dirname, "..", "..", "..", "assets", "screenshots");

const PAGES = [
  { name: "home", path: "/" },
  { name: "lap-analytics", path: "/f125/sessions", readyText: "Metrics at Cursor" },
  { name: "compare", path: "/f125/compare", hover: ".u-over" },
  { name: "tracks", path: "/f125/tracks" },
  { name: "track-detail-guide", path: "/f125/tracks/19", readyText: "Expert guide" },
  { name: "car-catalogue-f125-grid", path: "/f125/cars" },
  { name: "car-catalogue-forza", path: "/fm23/cars" },
  { name: "setups", path: "/f125/tracks/19/setups" },
  { name: "setups-ranges", path: "/f125/tracks/19/setups?subtab=ranges" },
  { name: "car-compare-forza", path: "/fm23/cars?compare=1023,1020,3062" },
];


for (const page of PAGES) {
  test(`screenshot: ${page.name}`, async ({ page: p }) => {
    await p.addInitScript(() => localStorage.setItem("forza-onboarding-complete", "true"));
    const comparePair = page.name === "compare"
      ? findTrackCarPairWithTwoLaps(await getSeededLaps(p.request, "f1-2025"))
      : null;
    if (page.name === "compare" && !comparePair) {
      throw new Error("No F1 seeded lap pair for compare screenshot");
    }
    const target = page.name === "lap-analytics"
      ? await getSeededLapTarget(p.request, "f1-2025")
      : null;
    const path = comparePair
      ? `/f125/compare?${new URLSearchParams({
          track: String(comparePair.trackOrdinal),
          carA: String(comparePair.carOrdinal),
          lapA: String(comparePair.lapA.id),
          carB: String(comparePair.carOrdinal),
          lapB: String(comparePair.lapB.id),
          cursor: "7",
        })}`
      : target
        ? `/f125/sessions/${target.sessionId}/replay/${target.id}?viz=3d`
        : page.path;
    await p.goto(path, { waitUntil: "domcontentloaded" });
    // Dynamic route IDs avoid coupling screenshots to fixture database IDs.
    if (comparePair) {
      await p.getByLabel("Lap A").waitFor({ state: "visible" });
      await expect(p.getByLabel("Lap A")).toHaveValue(lapOptionLabel(comparePair.lapA));
      await expect(p.getByLabel("Lap B")).toHaveValue(lapOptionLabel(comparePair.lapB));
      await p.getByTestId("lap-compare-workspace").getByText("Time Delta").waitFor({ state: "visible" });
    }

    if ("readyText" in page && page.readyText) {
      const ready = p.getByText(page.readyText, { exact: true }).first();
      await ready.waitFor({ state: "visible", timeout: 30_000 });
      await ready.scrollIntoViewIfNeeded();
    }
    await p.waitForTimeout(1500);
    if ("hover" in page && page.hover) {
      const el = p.locator(page.hover).first();
      await el.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await p.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
        await p.waitForTimeout(300);
      }
    }
    await p.screenshot({
      path: `${SCREENSHOT_DIR}/${page.name}.png`,
      fullPage: false,
      timeout: page.name === "lap-analytics" ? 60_000 : undefined,
    });
  });
}

test("screenshot: car-catalogue-f125-table", async ({ page: p }) => {
  await p.addInitScript(() => localStorage.setItem("forza-onboarding-complete", "true"));
  await p.goto("/f125/cars", { waitUntil: "networkidle" });
  await p.getByTitle("Table view").waitFor({ state: "visible" });
  await p.getByTitle("Table view").click();
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: `${SCREENSHOT_DIR}/car-catalogue-f125-table.png`,
    fullPage: false,
  });
});

test("screenshot: car-catalogue-forza-grid", async ({ page: p }) => {
  await p.addInitScript(() => localStorage.setItem("forza-onboarding-complete", "true"));
  await p.goto("/fm23/cars", { waitUntil: "networkidle" });
  await p.getByTitle("Grid view").waitFor({ state: "visible" });
  await p.getByTitle("Grid view").click();
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: `${SCREENSHOT_DIR}/car-catalogue-forza-grid.png`,
    fullPage: false,
  });
});

test("generate screenshots README", async () => {
  const dir = resolve(__dirname, SCREENSHOT_DIR);
  const images = readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    .sort();

  const lines = ["# Screenshots", ""];
  for (const img of images) {
    const title = img.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    lines.push(`### ${title}`, "", `![${title}](${img})`, "");
  }

  writeFileSync(resolve(dir, "README.md"), lines.join("\n"));
});
