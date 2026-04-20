import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";
import { tmpdir } from "os";

// Isolate the test DB + settings dir so tests never touch the user's real data.
// Spawned server honours DATA_DIR (see server/env.ts).
const TEST_DATA_DIR = process.env.TUNES_E2E_DATA_DIR
  ?? resolve(tmpdir(), `raceiq-tunes-e2e-${Date.now()}`);

const CLIENT_PORT = 5199;
const SERVER_PORT = 3198;

export default defineConfig({
  testDir: "./e2e/tunes",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  fullyParallel: false, // shared dev server + shared DB
  workers: 1,
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `DATA_DIR=${TEST_DATA_DIR} SERVER_PORT=${SERVER_PORT} bun run ../server/index.ts`,
      url: `http://localhost:${SERVER_PORT}/api/settings`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `PORT=${CLIENT_PORT} PROXY_TARGET=http://localhost:${SERVER_PORT} bun run vite`,
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
