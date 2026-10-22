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
  ];
  const nativeGpuSpecs = [
    "compare/spectate-native-camera.spec.ts",
    "compare/spectate-transition.spec.ts",
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
    ...(["tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page"] as const).map((name) => ({
      name,
      testDir: resolve(__dirname, "../../packages", name, "test/e2e"),
      testIgnore: name === "lap-replay" ? nativeGpuSpecs : [],
      dependencies: ["seeded-setup"],
      fullyParallel: true,
      workers: name === "tracks-catalogue" || name === "sessions-page" ? 1 : undefined,
      timeout: name === "sessions-page" ? 720_000 : 140_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    })),
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
      testIgnore: [...sequentialImportSpecs, "seeded/routes/**/*.spec.ts"],
      fullyParallel: true,
      timeout: 140_000,
      use: { baseURL: seededBaseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "lap-replay-webgpu",
      testDir: resolve(__dirname, "../../packages/lap-replay/test/e2e"),
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
      dependencies: ["seeded-routes", "seeded-e2e", "seeded-imports", "lap-replay-webgpu", "tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page"],
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
