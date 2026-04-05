import { test } from "@playwright/test";

const PAGES = [
  { name: "home", path: "/" },
  { name: "lap-analytics", path: "/f125/analyse" },
  { name: "compare", path: "/f125/compare" },
  { name: "tracks", path: "/f125/tracks" },
  { name: "car-catalogue", path: "/f125/cars" },
  { name: "tunes", path: "/f125/tunes" },
];

for (const page of PAGES) {
  test(`screenshot: ${page.name}`, async ({ page: p }) => {
    await p.goto(page.path, { waitUntil: "networkidle" });
    // Give animations/charts a moment to settle
    await p.waitForTimeout(1500);
    await p.screenshot({
      path: `screenshots/${page.name}.png`,
      fullPage: false,
    });
  });
}
