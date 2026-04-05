import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    baseURL: "https://raceiq.localhost",
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    colorScheme: "dark",
  },
  testDir: ".",
  outputDir: "./test-results",
  projects: [
    {
      name: "marketing",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
