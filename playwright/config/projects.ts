import type { PlaywrightTestConfig } from "@playwright/test";
import { resolve } from "node:path";
import type { E2ERuntime } from "./runtime";

export function createProjects(runtime: E2ERuntime): NonNullable<PlaywrightTestConfig["projects"]> {
  const freshBaseURL = `http://localhost:${runtime.devServer ? runtime.freshInstall.clientPort : runtime.freshInstall.port}`;
  const seededBaseURL = `http://localhost:${runtime.devServer ? runtime.seeded.clientPort : runtime.seeded.port}`;
  const tunesBaseURL = `http://localhost:${runtime.devServer ? runtime.tunes.clientPort : runtime.tunes.port}`;
  const tunesUnseededBaseURL = `http://localhost:${runtime.devServer ? runtime.tunesUnseeded.clientPort : runtime.tunesUnseeded.port}`;
  const sequentialImportSpecs = [
    "seeded/analyse/core-flow.spec.ts",
    "seeded/dev-tools/server-import.spec.ts",
    "seeded/sessions/import.spec.ts",
    "seeded/sessions/lifecycle.spec.ts",
  ];
  const nativeGpuSpecs = [
    "seeded/compare/spectate-native-camera.spec.ts",
    "seeded/compare/spectate-transition.spec.ts",
  ];

  const splitMigrationSpec = "setup/sparse-split-migration.spec.ts";

  return [
    {
      name: "fresh-install",
      testMatch: "fresh-install/**/*.spec.ts",
      workers: 1,
      use: { baseURL: freshBaseURL, viewport: { width: 1280, height: 900 } },
    },
    {
      name: "tunes-setup",
      testMatch: splitMigrationSpec,
      workers: 1,
      use: { baseURL: tunesBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tunes",
      dependencies: ["tunes-setup"],
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
      name: "seeded-setup",
      testMatch: splitMigrationSpec,
      workers: 1,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    ...(["tracks-catalogue", "cars-catalogue"] as const).map((name) => ({
      name,
      testDir: resolve(__dirname, "../../packages", name, "test/e2e"),
      dependencies: ["seeded-setup"],
      fullyParallel: true,
      workers: name === "tracks-catalogue" ? 1 : undefined,
      timeout: 140_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    })),
    {
      name: "race-strategy",
      testDir: resolve(__dirname, "../../packages/race-strategy/test/e2e"),
      fullyParallel: false,
      workers: 1,
      timeout: 240_000,
      expect: { timeout: 15_000 },
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "seeded-routes",
      dependencies: ["seeded-setup"],
      testMatch: "seeded/routes/**/*.spec.ts",
      fullyParallel: true,
      timeout: 140_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "seeded-e2e",
      dependencies: ["seeded-setup"],
      testMatch: "seeded/**/*.spec.ts",
      testIgnore: [...sequentialImportSpecs, ...nativeGpuSpecs, "seeded/routes/**/*.spec.ts"],
      fullyParallel: true,
      timeout: 140_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "seeded-webgpu",
      dependencies: ["seeded-setup"],
      testMatch: nativeGpuSpecs,
      workers: 1,
      use: {
        baseURL: seededBaseURL,
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: ["--enable-unsafe-webgpu", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])] },
      },
    },
    {
      name: "seeded-imports",
      dependencies: ["seeded-setup"],
      testMatch: sequentialImportSpecs,
      fullyParallel: true,
      workers: 1,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      dependencies: ["seeded-routes", "seeded-e2e", "seeded-imports", "seeded-webgpu", "tracks-catalogue", "cars-catalogue", "race-strategy"],
      fullyParallel: true,
      name: "record-demo",
      testMatch: "recording/demo.spec.ts",
      timeout: 140_000,
      use: {
        baseURL: seededBaseURL,
        actionTimeout: 120_000,
        viewport: { width: 1920, height: 1080 },
        launchOptions: {
          args: ["--enable-gpu", "--enable-gpu-rasterization", "--enable-features=Vulkan,UseSkiaRenderer", "--ignore-gpu-blocklist", "--enable-webgl", "--disable-software-rasterizer"],
        },
      },
    },
  ];
}
