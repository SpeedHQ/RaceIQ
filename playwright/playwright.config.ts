import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

// Onboarding project runs against the compiled production binary (`dist/raceiq`)
// with an isolated DATA_DIR so each run simulates a fresh install.
// Marketing project runs against the user's running dev server
// (`https://raceiq.localhost` via portless) and captures screenshots.
//
// Note: pre-seeding an empty settings.json skips the binary's first-run
// "open browser" branch — spawn("open") currently kills the compiled macOS
// binary. Onboarding still fires because onboardingComplete defaults to false.

const ONBOARDING_PORT = process.env.PW_ONBOARDING_PORT ?? "3118";
const ONBOARDING_UDP_PORT = process.env.PW_ONBOARDING_UDP_PORT ?? "15318";
const ONBOARDING_DATA_DIR = resolve(__dirname, "test-data");
const BINARY_NAME = process.platform === "win32" ? "raceiq.exe" : "raceiq";
const BINARY = resolve(__dirname, "..", "dist", BINARY_NAME);

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    ...devices["Desktop Chrome"],
    ignoreHTTPSErrors: true,
    colorScheme: "dark",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "onboarding",
      testMatch: "onboarding.spec.ts",
      use: {
        baseURL: `http://localhost:${ONBOARDING_PORT}`,
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "marketing",
      testMatch: "marketing.spec.ts",
      use: {
        baseURL: "https://raceiq.localhost",
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],

  webServer: [
    {
      command: `"${BINARY}"`,
      env: {
        DATA_DIR: ONBOARDING_DATA_DIR,
        SERVER_PORT: ONBOARDING_PORT,
        UDP_PORT: ONBOARDING_UDP_PORT,
        NODE_ENV: "production",
      },
      url: `http://localhost:${ONBOARDING_PORT}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
