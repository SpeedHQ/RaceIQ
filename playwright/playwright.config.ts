import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

// Three Playwright projects, all run via the compiled raceiq binary:
//
//   fresh-install — boots raceiq.exe with an empty DATA_DIR so the onboarding
//                   wizard + home-page smoke tests run against a simulated
//                   first-run install.
//   marketing     — captures screenshots against the user's running dev server
//                   at https://raceiq.localhost (portless).
//   tunes         — boots a second raceiq.exe instance on an isolated DATA_DIR
//                   and exercises the FM23 / ACC / AC-EVO tune flows end-to-
//                   end. Runs against the compiled binary (not the dev
//                   server) so the tests exercise the same code path users
//                   see on a real install.
//
// Note: pre-seeding an empty settings.json skips the binary's first-run
// "open browser" branch — spawn("open") currently kills the compiled macOS
// binary. Onboarding still fires because onboardingComplete defaults to false.

const FRESH_INSTALL_PORT = process.env.PW_FRESH_INSTALL_PORT ?? "3118";
const FRESH_INSTALL_UDP_PORT = process.env.PW_FRESH_INSTALL_UDP_PORT ?? "15318";
const FRESH_INSTALL_DATA_DIR = resolve(__dirname, "test-data");

const TUNES_PORT = process.env.PW_TUNES_PORT ?? "3119";
const TUNES_UDP_PORT = process.env.PW_TUNES_UDP_PORT ?? "15319";
const TUNES_DATA_DIR = resolve(__dirname, "test-data-tunes");

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
