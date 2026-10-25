import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../packages/lap-replay/test/e2e",
  testMatch: ["analyse/workspace.spec.ts", "compare/spectate-preferences.spec.ts"],
  grep: /AMS2 reduced-rate Polo replay|AMS2 Spectate renders animated suspension/,
  outputDir: "/tmp/raceiq-suspension-e2e",
  workers: 1,
  expect: { timeout: 20_000 },
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
    baseURL: "http://ams2-pr-review.raceiq-610738dc0d5a4dbe.localhost:1355",
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    actionTimeout: 20_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
