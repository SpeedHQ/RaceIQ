import { test } from "@playwright/test";

const PAGES = [
  { name: "home", path: "/" },
  { name: "lap-analytics", path: "/f125/analyse" },
  { name: "compare", path: "/f125/compare" },
  { name: "tracks", path: "/f125/tracks" },
  { name: "car-catalogue-f125-grid", path: "/f125/cars" },
  { name: "car-catalogue-forza-table", path: "/fm23/cars" },
  { name: "setups", path: "/f125/tracks?track=3&tab=setups" },
  { name: "setups-compare", path: "/f125/tracks?track=3&tab=setups&subtab=ranges" },
];

for (const page of PAGES) {
  test(`screenshot: ${page.name}`, async ({ page: p }) => {
    await p.addInitScript(() =>
      localStorage.setItem("forza-onboarding-complete", "true"),
    );
    await p.goto(page.path, { waitUntil: "networkidle" });
    await p.waitForTimeout(1500);
    await p.screenshot({
      path: `assets/screenshots/${page.name}.png`,
      fullPage: false,
    });
  });
}

// Alternate view screenshots (click toggle then capture)
test("screenshot: car-catalogue-f125-table", async ({ page: p }) => {
  await p.addInitScript(() =>
    localStorage.setItem("forza-onboarding-complete", "true"),
  );
  await p.goto("/f125/cars", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Compare" }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: "assets/screenshots/car-catalogue-f125-table.png",
    fullPage: false,
  });
});

test("screenshot: car-catalogue-forza-grid", async ({ page: p }) => {
  await p.addInitScript(() =>
    localStorage.setItem("forza-onboarding-complete", "true"),
  );
  await p.goto("/fm23/cars", { waitUntil: "networkidle" });
  await p.getByTitle("Grid view").click();
  await p.waitForTimeout(1500);
  await p.screenshot({
    path: "assets/screenshots/car-catalogue-forza-grid.png",
    fullPage: false,
  });
});
