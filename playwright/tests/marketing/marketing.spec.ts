import { test } from "@playwright/test";
import { writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SCREENSHOT_DIR = resolve(__dirname, "..", "..", "..", "assets", "screenshots");

const PAGES = [
  { name: "home", path: "/" },
  { name: "lap-analytics", path: "/f125/analyse?track=19&car=41&lap=4&viz=3d" },
  { name: "compare", path: "/f125/compare?track=19&carA=41&lapA=4&carB=41&lapB=5", hover: ".u-over" },
  { name: "tracks", path: "/f125/tracks" },
  { name: "car-catalogue-f125-grid", path: "/f125/cars" },
  { name: "car-catalogue-forza", path: "/fm23/cars" },
  { name: "setups", path: "/f125/tracks/19/setups" },
  { name: "setups-ranges", path: "/f125/tracks/19/setups?subtab=ranges" },
  { name: "car-compare-forza", path: "/fm23/cars?compare=1023,1020,3062" },
  { name: "experiments-review-overview", path: "/f125/experiments/1/review?laps=4,5,6,7,8&view=overview" },
  { name: "experiments-review-track", path: "/f125/experiments/1/review?laps=4,5,6,7,8&view=track" },
  { name: "experiments-review-track-tires", path: "/f125/experiments/1/review?laps=4,5,6,7,8&view=track&trackTab=tires" },
  { name: "experiments-review-track-balance", path: "/f125/experiments/1/review?laps=4,5,6,7,8&view=track&trackTab=balance" },
  { name: "experiments-review-track-suspension", path: "/f125/experiments/1/review?laps=4,5,6,7,8&view=track&trackTab=suspension" },
  { name: "experiments-review-sector-1", path: "/f125/experiments/1/review?laps=4,5,6,7,8&view=s1" },
];
for (const page of PAGES) {
  test(`screenshot: ${page.name}`, async ({ page: p }) => {
    if (page.name === "lap-analytics") test.setTimeout(60_000);
    await p.addInitScript(() => localStorage.setItem("forza-onboarding-complete", "true"));
    if (page.name.startsWith("experiments-review-")) {
      const response = await p.request.post("/api/experiments/1/import-laps", {
        data: { lapIds: [4, 5, 6, 7, 8], experimentVersionId: 2 },
      });
      if (![201, 409].includes(response.status())) throw new Error(`Failed to seed experiment review laps: ${response.status()}`);
    }
    await p.goto(page.path, { waitUntil: "networkidle" });
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
      timeout: page.name === "lap-analytics" ? 30_000 : undefined,
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
