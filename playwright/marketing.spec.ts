import { test } from "@playwright/test";

const SCREENSHOT_DIR = "../assets/screenshots";

const PAGES = [
  { name: "home", path: "/" },
  { name: "lap-analytics", path: "/f125/analyse?track=6&car=41&lap=257&cursor=12000&viz=3d" },
  { name: "compare", path: "/f125/compare?track=6&carA=41&lapA=258&carB=41&lapB=260", hover: ".u-over" },
  { name: "tracks", path: "/f125/tracks" },
  { name: "car-catalogue-f125-grid", path: "/f125/cars" },
  { name: "car-catalogue-forza", path: "/fm23/cars" },
  { name: "setups", path: "/f125/tracks?track=3&tab=setups" },
  { name: "setups-ranges", path: "/f125/tracks?track=3&tab=setups&subtab=ranges" },
  { name: "car-compare-forza", path: "/fm23/cars?compare=1023,1020,3062" },
];

for (const page of PAGES) {
  test(`screenshot: ${page.name}`, async ({ page: p }) => {
    await p.addInitScript(() =>
      localStorage.setItem("forza-onboarding-complete", "true"),
    );
    await p.goto(page.path, { waitUntil: "networkidle" });
    await p.waitForTimeout(1500);
    if ("hover" in page && page.hover) {
      const el = p.locator(page.hover).first();
      await el.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      const box = await el.boundingBox();
      if (box) {
        await p.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
        await p.waitForTimeout(300);
      }
    }
    await p.screenshot({
      path: `${SCREENSHOT_DIR}/${page.name}.png`,
      fullPage: false,
    });
  });
}

test("screenshot: car-catalogue-f125-table", async ({ page: p }) => {
  await p.addInitScript(() =>
    localStorage.setItem("forza-onboarding-complete", "true"),
  );
  await p.goto("/f125/cars", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Compare" }).waitFor({ state: "visible" });
  await p.getByRole("button", { name: "Compare" }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: `${SCREENSHOT_DIR}/car-catalogue-f125-table.png`,
    fullPage: false,
  });
});

test("screenshot: car-catalogue-forza-grid", async ({ page: p }) => {
  await p.addInitScript(() =>
    localStorage.setItem("forza-onboarding-complete", "true"),
  );
  await p.goto("/fm23/cars", { waitUntil: "networkidle" });
  await p.getByTitle("Grid view").waitFor({ state: "visible" });
  await p.getByTitle("Grid view").click();
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: `${SCREENSHOT_DIR}/car-catalogue-forza-grid.png`,
    fullPage: false,
  });
});
