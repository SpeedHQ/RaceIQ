import { devices, type PlaywrightTestConfig } from "@playwright/test";
import type { E2ERuntime } from "./runtime";

export function createProjects(runtime: E2ERuntime): NonNullable<PlaywrightTestConfig["projects"]> {
  const freshBaseURL = `http://localhost:${runtime.devServer ? runtime.freshInstall.clientPort : runtime.freshInstall.port}`;
  const seededBaseURL = `http://localhost:${runtime.devServer ? runtime.seeded.clientPort : runtime.seeded.port}`;
  const tunesBaseURL = `http://localhost:${runtime.devServer ? runtime.tunes.clientPort : runtime.tunes.port}`;
  const tunesUnseededBaseURL = `http://localhost:${runtime.devServer ? runtime.tunesUnseeded.clientPort : runtime.tunesUnseeded.port}`;
  const sequentialImportSpecs = [
    "seeded/analyse/core-flow.spec.ts",
    "seeded/catalog/tracks.spec.ts",
    "seeded/dev-tools/server-import.spec.ts",
    "seeded/sessions/import.spec.ts",
    "seeded/sessions/lifecycle.spec.ts",
  ] as const;

  return [
    {
      name: "fresh-install",
      testMatch: ["fresh-install/**/*.spec.ts", "responsive/workspaces.spec.ts"],
      workers: 1,
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
      grepInvert: /import page renders empty state when Documents folder absent/,
      workers: 1,
      use: { baseURL: tunesBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tunes-unseeded",
      testMatch: ["tunes/ac-evo.spec.ts", "tunes/acc.spec.ts"],
      grep: /import page renders empty state when Documents folder absent/,
      workers: 1,
      use: { baseURL: tunesUnseededBaseURL, viewport: { width: 1440, height: 900 } },
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
      name: "seeded-routes",
      testMatch: "seeded/routes/**/*.spec.ts",
      timeout: 120_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "seeded-e2e",
      testMatch: "seeded/**/*.spec.ts",
      testIgnore: [...sequentialImportSpecs, "seeded/routes/**/*.spec.ts"],
      timeout: 120_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "seeded-imports",
      testMatch: sequentialImportSpecs,
      workers: 1,
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
