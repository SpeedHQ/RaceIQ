import { test } from "@playwright/test";

const PAGES = [
  { name: "home", path: "/" },
  { name: "lap-analytics", path: "/f125/analyse" },
  { name: "compare", path: "/f125/compare" },
  { name: "tracks", path: "/f125/tracks" },
  { name: "car-catalogue", path: "/f125/cars" },
  { name: "car-catalogue-forza", path: "/fm23/cars" },
  { name: "setups", path: "/f125/tracks?track=3&tab=setups" },
  { name: "setups-compare", path: "/f125/tracks?track=3&tab=setups&subtab=ranges" },
];

for (const page of PAGES) {
  test(`screenshot: ${page.name}`, async ({ page: p }) => {
    // Set onboarding complete before the app loads to avoid redirect
    await p.addInitScript(() =>
      localStorage.setItem("forza-onboarding-complete", "true"),
    );
    await p.goto(page.path, { waitUntil: "networkidle" });
    // Give animations/charts a moment to settle
    await p.waitForTimeout(1500);
    await p.screenshot({
      path: `assets/screenshots/${page.name}.png`,
      fullPage: false,
    });
  });
}
