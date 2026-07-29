import { defineConfig, devices } from "@playwright/test";
import { createProjects } from "./config/projects";
import { runtime } from "./config/runtime";
import { createWebServers } from "./config/web-servers";

export default defineConfig({
  testDir: "tests",
  outputDir: "./test-results",
  fullyParallel: runtime.parallelScreenshotRun,
  workers: runtime.parallelScreenshotRun ? runtime.screenshotWorkers : 1,
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
        baseURL: process.env.MARKETING_BASE_URL ?? "https://raceiq.localhost",
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: "mobile-screenshots",
      testMatch: "mobile-responsive.spec.ts",
      use: {
        baseURL: `http://localhost:${FRESH_INSTALL_PORT}`,
        // Viewport is overridden per-describe-block in the spec.
      },
    },
    {
      name: "reprocessing",
      testMatch: "reprocessing.spec.ts",
      use: {
        baseURL: `http://localhost:${FRESH_INSTALL_PORT}`,
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "tunes",
      testMatch: "tunes/*.spec.ts",
      use: {
        baseURL: `http://localhost:${TUNES_PORT}`,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "record-demo",
      testMatch: "record-demo.spec.ts",
      timeout: 120_000,
      use: {
        baseURL: `http://localhost:${FRESH_INSTALL_PORT}`,
        viewport: { width: 1920, height: 1080 },
        actionTimeout: 120_000,
        launchOptions: {
          // Force GPU hardware acceleration even in headless — otherwise
          // Chromium falls back to SwiftShader (software WebGL) and 1920×1080
          // Three.js rendering becomes the bottleneck (~400ms/frame).
          args: [
            "--enable-gpu",
            "--enable-gpu-rasterization",
            "--enable-unsafe-webgpu",
            "--enable-features=Vulkan,UseSkiaRenderer",
            "--ignore-gpu-blocklist",
            "--enable-webgl",
            "--disable-software-rasterizer",
          ],
        },
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
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
