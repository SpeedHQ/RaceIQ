import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

// The default fresh-install/tunes projects run against the compiled binary.
// PR CI sets E2E_SERVER_MODE=dev to run the same projects against isolated
// Bun + Vite development servers instead. Keep mode values explicit so a
// misspelled workflow setting cannot silently select compiled input.
const E2E_SERVER_MODE = process.env.E2E_SERVER_MODE ?? "compiled";
if (E2E_SERVER_MODE !== "dev" && E2E_SERVER_MODE !== "compiled") {
  throw new Error(`Unsupported E2E_SERVER_MODE "${E2E_SERVER_MODE}" (expected dev or compiled)`);
}
const SERVER_SET = process.env.PW_SERVER_SET ?? "all";
if (!["all", "fresh", "tunes", "seeded"].includes(SERVER_SET)) {
  throw new Error(`Unsupported PW_SERVER_SET "${SERVER_SET}" (expected all, fresh, tunes, or seeded)`);
}
const NEEDS_FRESH_SERVER = SERVER_SET === "all" || SERVER_SET === "fresh";
const NEEDS_TUNES_SERVER = SERVER_SET === "all" || SERVER_SET === "tunes";
const NEEDS_SEEDED_SERVER = SERVER_SET === "all" || SERVER_SET === "seeded";
const E2E_DEV_SERVER = E2E_SERVER_MODE === "dev";
const SCREENSHOT_ONLY = process.env.PW_SCREENSHOT_ONLY === "1";
const SEEDED_SCREENSHOTS = process.env.PW_SEED_SCREENSHOTS === "1";
const PARALLEL_SCREENSHOT_RUN = SCREENSHOT_ONLY && SEEDED_SCREENSHOTS;
const APP_ROOT = process.env.RACEIQ_APP_ROOT;
const defaultScreenshotWorkers = process.env.CI ? 2 : 4;
const requestedScreenshotWorkers = Number.parseInt(
  process.env.PW_SCREENSHOT_WORKERS ?? String(defaultScreenshotWorkers),
  10,
);
const SCREENSHOT_WORKERS = Number.isFinite(requestedScreenshotWorkers) && requestedScreenshotWorkers > 0
  ? requestedScreenshotWorkers
  : defaultScreenshotWorkers;

const FRESH_INSTALL_PORT = process.env.PW_FRESH_INSTALL_PORT ?? "3118";
const FRESH_INSTALL_CLIENT_PORT = process.env.PW_FRESH_INSTALL_CLIENT_PORT ?? "4118";
const FRESH_INSTALL_UDP_PORT = process.env.PW_FRESH_INSTALL_UDP_PORT ?? "15318";
const FRESH_INSTALL_DATA_DIR = resolve(
  process.env.PW_FRESH_INSTALL_DATA_DIR ?? resolve(__dirname, "test-data"),
);

const TUNES_PORT = process.env.PW_TUNES_PORT ?? "3119";
const TUNES_CLIENT_PORT = process.env.PW_TUNES_CLIENT_PORT ?? "4119";
const TUNES_UDP_PORT = process.env.PW_TUNES_UDP_PORT ?? "15319";
const TUNES_DATA_DIR = resolve(
  process.env.PW_TUNES_DATA_DIR ?? resolve(__dirname, "test-data-tunes"),
);

const SEEDED_E2E_PORT = process.env.PW_SEEDED_E2E_PORT ?? "3120";
const SEEDED_E2E_CLIENT_PORT = process.env.PW_SEEDED_E2E_CLIENT_PORT ?? "4120";
const SEEDED_E2E_UDP_PORT = process.env.PW_SEEDED_E2E_UDP_PORT ?? "15320";
const SEEDED_E2E_DATA_DIR = resolve(
  process.env.PW_SEEDED_E2E_DATA_DIR
    ?? resolve(__dirname, "test-results", "test-data-seeded"),
);

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  // Screenshot-only runs are read-only after fixture seeding. Spread their
  // independent routes across browser workers; keep stateful E2E projects
  // single-worker and ordered.
  fullyParallel: PARALLEL_SCREENSHOT_RUN,
  workers: PARALLEL_SCREENSHOT_RUN ? SCREENSHOT_WORKERS : 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 10_000 },

  use: {
    ...devices["Desktop Chrome"],
    ignoreHTTPSErrors: true,
    colorScheme: "dark",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },

  projects: [
    // Viewport layout checks: deterministic CSS breakpoints and screenshot
    // evidence. These projects intentionally do not emulate a device.
    {
      name: "fresh-install",
      testMatch: ["fresh-install.spec.ts", "responsive-workspaces.spec.ts"],
      use: {
        baseURL: `http://localhost:${E2E_DEV_SERVER ? FRESH_INSTALL_CLIENT_PORT : FRESH_INSTALL_PORT}`,
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "marketing",
      testMatch: "marketing.spec.ts",
      use: {
        baseURL: process.env.MARKETING_BASE_URL ?? "https://raceiq.localhost",
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: "mobile-screenshots",
      testMatch: "mobile-responsive.spec.ts",
      use: {
        baseURL: `http://localhost:${E2E_DEV_SERVER ? SEEDED_E2E_CLIENT_PORT : SEEDED_E2E_PORT}`,
        // Viewport is overridden per-describe-block in the spec.
      },
    },
    {
      name: "tunes",
      testMatch: "tunes/*.spec.ts",
      use: {
        baseURL: `http://localhost:${E2E_DEV_SERVER ? TUNES_CLIENT_PORT : TUNES_PORT}`,
        viewport: { width: 1440, height: 900 },
      },
    },
    // Real Chromium device emulation: touch, mobile user agent, and device
    // viewport are part of this functional smoke gate, not screenshot cases.
    {
      name: "mobile-device",
      testMatch: "device-responsive.spec.ts",
      use: {
        ...devices["Pixel 7"],
        baseURL: `http://localhost:${E2E_DEV_SERVER ? SEEDED_E2E_CLIENT_PORT : SEEDED_E2E_PORT}`,
      },
    },
    {
      name: "tablet-device",
      testMatch: "device-responsive.spec.ts",
      use: {
        ...devices["iPad (gen 7)"],
        baseURL: `http://localhost:${E2E_DEV_SERVER ? SEEDED_E2E_CLIENT_PORT : SEEDED_E2E_PORT}`,
      },
    },
    // E2E_SERVER_MODE. CI selects projects explicitly through reusable inputs.
    {
      name: "seeded-e2e",
      testMatch: "seeded-*.spec.ts",
      timeout: 120_000,
      use: {
        baseURL: `http://localhost:${E2E_DEV_SERVER ? SEEDED_E2E_CLIENT_PORT : SEEDED_E2E_PORT}`,
        viewport: { width: 1440, height: 900 },
      },
    },
    // Hardware-only capture: GPU flags and long-lived canvas recording are
    // intentionally isolated from functional and responsive gates.
    {
      name: "record-demo",
      testMatch: "record-demo.spec.ts",
      timeout: 120_000,
      use: {
        baseURL: `http://localhost:${E2E_DEV_SERVER ? FRESH_INSTALL_CLIENT_PORT : FRESH_INSTALL_PORT}`,
        actionTimeout: 120_000,
        launchOptions: {
          args: [
            "--enable-gpu",
            "--enable-gpu-rasterization",
            "--enable-features=Vulkan,UseSkiaRenderer",
            "--ignore-gpu-blocklist",
            "--enable-webgl",
            "--disable-software-rasterizer",
          ],
        },
      },
    },
  ],

  webServer: E2E_DEV_SERVER
    ? [
        ...(NEEDS_FRESH_SERVER
          ? [
              {
                command: `bun start-dev-server.ts`,
                env: {
                  DATA_DIR: FRESH_INSTALL_DATA_DIR,
                  SERVER_PORT: FRESH_INSTALL_PORT,
                  CLIENT_PORT: FRESH_INSTALL_CLIENT_PORT,
                  UDP_PORT: FRESH_INSTALL_UDP_PORT,
                  NODE_ENV: "test",
                  ...(APP_ROOT ? { RACEIQ_APP_ROOT: APP_ROOT } : {}),
                },
                url: `http://localhost:${FRESH_INSTALL_CLIENT_PORT}`,
                timeout: 120_000,
                reuseExistingServer: false,
                stdout: "pipe" as const,
                stderr: "pipe" as const,
              },
            ]
          : []),
        ...(!SCREENSHOT_ONLY && NEEDS_TUNES_SERVER
          ? [
              {
                command: `bun start-dev-server.ts`,
                env: {
                  DATA_DIR: TUNES_DATA_DIR,
                  SERVER_PORT: TUNES_PORT,
                  CLIENT_PORT: TUNES_CLIENT_PORT,
                  UDP_PORT: TUNES_UDP_PORT,
                  NODE_ENV: "test",
                  ...(APP_ROOT ? { RACEIQ_APP_ROOT: APP_ROOT } : {}),
                },
                url: `http://localhost:${TUNES_CLIENT_PORT}`,
                timeout: 120_000,
                reuseExistingServer: false,
                stdout: "pipe" as const,
                stderr: "pipe" as const,
              },
            ]
          : []),
        ...(NEEDS_SEEDED_SERVER
          ? [
              {
                command: `bun start-dev-server.ts`,
                env: {
                  DATA_DIR: SEEDED_E2E_DATA_DIR,
                  SERVER_PORT: SEEDED_E2E_PORT,
                  CLIENT_PORT: SEEDED_E2E_CLIENT_PORT,
                  UDP_PORT: SEEDED_E2E_UDP_PORT,
                  NODE_ENV: "test",
                  PW_SEED_SCREENSHOTS: "1",
                  RACEIQ_E2E: "1",
                  ...(APP_ROOT ? { RACEIQ_APP_ROOT: APP_ROOT } : {}),
                },
                url: `http://localhost:${SEEDED_E2E_CLIENT_PORT}`,
                timeout: 120_000,
                reuseExistingServer: false,
                stdout: "pipe" as const,
                stderr: "pipe" as const,
              },
            ]
          : []),
      ]
    : [
        ...(NEEDS_FRESH_SERVER
          ? [
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
                reuseExistingServer: false,
                stdout: "pipe" as const,
                stderr: "pipe" as const,
              },
            ]
          : []),
        ...(NEEDS_TUNES_SERVER
          ? [
              {
                command: `bun start-server.ts`,
                env: {
                  DATA_DIR: TUNES_DATA_DIR,
                  SERVER_PORT: TUNES_PORT,
                  UDP_PORT: TUNES_UDP_PORT,
                  NODE_ENV: "production",
                },
                url: `http://localhost:${TUNES_PORT}`,
                timeout: 120_000,
                reuseExistingServer: false,
                stdout: "pipe" as const,
                stderr: "pipe" as const,
              },
            ]
          : []),
        ...(NEEDS_SEEDED_SERVER
          ? [
              {
                command: `bun start-server.ts`,
                env: {
                  DATA_DIR: SEEDED_E2E_DATA_DIR,
                  SERVER_PORT: SEEDED_E2E_PORT,
                  UDP_PORT: SEEDED_E2E_UDP_PORT,
                  NODE_ENV: "production",
                  PW_SEED_SCREENSHOTS: "1",
                  RACEIQ_E2E: "1",
                },
                url: `http://localhost:${SEEDED_E2E_PORT}`,
                timeout: 120_000,
                reuseExistingServer: false,
                stdout: "pipe" as const,
                stderr: "pipe" as const,
              },
            ]
          : []),
      ],
});
