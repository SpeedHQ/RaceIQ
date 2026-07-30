import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

// The default fresh-install/tunes projects run against the compiled binary.
// PR CI sets E2E_SERVER_MODE=dev to run the same projects against isolated
// Bun + Vite development servers instead.
const E2E_DEV_SERVER = process.env.E2E_SERVER_MODE === "dev";

const FRESH_INSTALL_PORT = process.env.PW_FRESH_INSTALL_PORT ?? "3118";
const FRESH_INSTALL_CLIENT_PORT = process.env.PW_FRESH_INSTALL_CLIENT_PORT ?? "4118";
const FRESH_INSTALL_UDP_PORT = process.env.PW_FRESH_INSTALL_UDP_PORT ?? "15318";
const FRESH_INSTALL_DATA_DIR = resolve(__dirname, "test-data");

const TUNES_PORT = process.env.PW_TUNES_PORT ?? "3119";
const TUNES_CLIENT_PORT = process.env.PW_TUNES_CLIENT_PORT ?? "4119";
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
        baseURL: `http://localhost:${E2E_DEV_SERVER ? FRESH_INSTALL_CLIENT_PORT : FRESH_INSTALL_PORT}`,
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
    {
      name: "record-demo",
      testMatch: "record-demo.spec.ts",
      timeout: 120_000,
      use: {
        baseURL: `http://localhost:${E2E_DEV_SERVER ? FRESH_INSTALL_CLIENT_PORT : FRESH_INSTALL_PORT}`,
        actionTimeout: 120_000,
        launchOptions: {
          // Force GPU hardware acceleration even in headless — otherwise
          // Chromium falls back to SwiftShader (software WebGL) and 1920×1080
          // Three.js rendering becomes the bottleneck (~400ms/frame).
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
        {
          command: `bun start-dev-server.ts`,
          env: {
            DATA_DIR: FRESH_INSTALL_DATA_DIR,
            SERVER_PORT: FRESH_INSTALL_PORT,
            CLIENT_PORT: FRESH_INSTALL_CLIENT_PORT,
            UDP_PORT: FRESH_INSTALL_UDP_PORT,
            NODE_ENV: "test",
          },
          url: `http://localhost:${FRESH_INSTALL_CLIENT_PORT}`,
          timeout: 120_000,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: `bun start-dev-server.ts`,
          env: {
            DATA_DIR: TUNES_DATA_DIR,
            SERVER_PORT: TUNES_PORT,
            CLIENT_PORT: TUNES_CLIENT_PORT,
            UDP_PORT: TUNES_UDP_PORT,
            NODE_ENV: "test",
          },
          url: `http://localhost:${TUNES_CLIENT_PORT}`,
          timeout: 120_000,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
        },
      ]
    : [
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
