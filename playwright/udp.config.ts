import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const mode = process.env.E2E_SERVER_MODE ?? "compiled";
if (mode !== "compiled" && mode !== "dev") throw new Error(`Unsupported E2E_SERVER_MODE: ${mode}`);
const compiled = mode === "compiled";
const baseURL = `http://127.0.0.1:${compiled ? 3132 : 4132}`;

// Dedicated server: UDP capture must start empty and cannot share a replay stream.
export default defineConfig({
  testDir: "tests/udp",
  outputDir: "test-results/udp",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "udp-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "udp-webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: compiled ? "bun support/server/start-server.ts" : "bun support/server/start-dev-server.ts",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATA_DIR: resolve(__dirname, "test-results/test-data-udp"),
      SERVER_PORT: "3132",
      CLIENT_PORT: "4132",
      UDP_PORT: "15332",
      RACEIQ_E2E: "1",
      RACEIQ_DISABLE_TRAY: "1",
      PW_ACCESS_MODE: "disabled",
      NODE_ENV: "production",
    },
  },
});
