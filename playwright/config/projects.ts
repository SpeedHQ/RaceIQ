import { devices, type PlaywrightTestConfig } from "@playwright/test";
import type { E2ERuntime } from "./runtime";

export function createProjects(runtime: E2ERuntime): NonNullable<PlaywrightTestConfig["projects"]> {
  const freshBaseURL = `http://localhost:${runtime.devServer ? runtime.freshInstall.clientPort : runtime.freshInstall.port}`;
  const seededBaseURL = `http://localhost:${runtime.devServer ? runtime.seeded.clientPort : runtime.seeded.port}`;
  const tunesBaseURL = `http://localhost:${runtime.devServer ? runtime.tunes.clientPort : runtime.tunes.port}`;

  return [
    {
      name: "fresh-install",
      testMatch: ["fresh-install/**/*.spec.ts", "responsive/workspaces.spec.ts"],
      use: { baseURL: freshBaseURL, viewport: { width: 1280, height: 900 } },
    },
    {
      name: "marketing",
      testMatch: "marketing/**/*.spec.ts",
      use: {
        baseURL: process.env.MARKETING_BASE_URL ?? "https://raceiq.localhost",
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: "mobile-screenshots",
      testMatch: "responsive/mobile-screenshots.spec.ts",
      use: { baseURL: seededBaseURL },
    },
    {
      name: "tunes",
      testMatch: "tunes/**/*.spec.ts",
      use: { baseURL: tunesBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-device",
      testMatch: "responsive/device.spec.ts",
      use: { ...devices["Pixel 7"], baseURL: seededBaseURL },
    },
    {
      name: "tablet-device",
      testMatch: "responsive/device.spec.ts",
      use: {
        ...devices["iPad (gen 7)"],
        browserName: "chromium",
        baseURL: seededBaseURL,
      },
    },
    {
      name: "seeded-e2e",
      testMatch: "seeded/**/*.spec.ts",
      timeout: 120_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "record-demo",
      testMatch: "recording/demo.spec.ts",
      timeout: 120_000,
      use: {
        baseURL: freshBaseURL,
        actionTimeout: 120_000,
        launchOptions: {
          args: ["--enable-gpu", "--enable-gpu-rasterization", "--enable-features=Vulkan,UseSkiaRenderer", "--ignore-gpu-blocklist", "--enable-webgl", "--disable-software-rasterizer"],
        },
      },
    },
  ];
}
