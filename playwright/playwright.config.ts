import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

// Fresh-install project runs against the compiled production binary
// (`dist/raceiq`) with an isolated DATA_DIR so each run simulates a new
// install (empty settings, onboarding wizard shown).
// Marketing project runs against the user's running dev server
// (`https://raceiq.localhost` via portless) and captures screenshots.
//
// Note: pre-seeding an empty settings.json skips the binary's first-run
// "open browser" branch — spawn("open") currently kills the compiled macOS
// binary. Onboarding still fires because onboardingComplete defaults to false.

const FRESH_INSTALL_PORT = process.env.PW_FRESH_INSTALL_PORT ?? "3118";
const FRESH_INSTALL_UDP_PORT = process.env.PW_FRESH_INSTALL_UDP_PORT ?? "15318";
const FRESH_INSTALL_DATA_DIR = resolve(__dirname, "test-data");

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
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
      name: "fresh-install",
      testMatch: "fresh-install.spec.ts",
      use: {
        baseURL: `http://localhost:${FRESH_INSTALL_PORT}`,
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
      command: `bun start-server.ts`,
      env: {
        DATA_DIR: FRESH_INSTALL_DATA_DIR,
        SERVER_PORT: FRESH_INSTALL_PORT,
        UDP_PORT: FRESH_INSTALL_UDP_PORT,
        NODE_ENV: "production",
      },
      url: `http://localhost:${FRESH_INSTALL_PORT}`,
      timeout: 120_000,
      // Never reuse: the server opens a SQLite connection on boot, so if the
      // binary kept running across runs the globalSetup's DATA_DIR wipe would
      // orphan the DB file while the server clung to the stale fd.
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
