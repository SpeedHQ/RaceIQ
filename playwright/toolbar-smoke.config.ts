import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ testDir: "tests/seeded/compare", testMatch: "spectate-preferences.spec.ts", outputDir: "/tmp/raceiq-toolbar-results", workers: 1, timeout: 140_000, expect: { timeout: 15_000 }, use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4149", colorScheme: "dark" } });
