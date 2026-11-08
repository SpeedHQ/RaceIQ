import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { releaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";

const productionEnv = parseEnv(readFileSync(".env.production", "utf8"));
releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: productionEnv.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: productionEnv.RACEIQ_FEATURE_IRACING_ADAPTER,
  RACEIQ_FEATURE_AMS2_ADAPTER: productionEnv.RACEIQ_FEATURE_AMS2_ADAPTER,
});
const featureDefines = Object.entries({
  RACEIQ_FEATURE_F1_EXPERIMENTS: productionEnv.RACEIQ_FEATURE_F1_EXPERIMENTS ?? "false",
  RACEIQ_FEATURE_IRACING_ADAPTER: productionEnv.RACEIQ_FEATURE_IRACING_ADAPTER ?? "false",
  RACEIQ_FEATURE_AMS2_ADAPTER: productionEnv.RACEIQ_FEATURE_AMS2_ADAPTER ?? "false",
}).flatMap(([name, value]) => ["--define", `process.env.${name}=${JSON.stringify(value)}`]);

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Release version must match MAJOR.MINOR.PATCH: ${version || "<missing>"}`);
}

const child = Bun.spawn([
  "bun",
  "build",
  "--compile",
  "--root",
  ".",
  "--target=bun-windows-x64",
  "--windows-icon=assets/raceiq.ico",
  "--windows-title=RaceIQ",
  "--windows-publisher=SpeedHQ",
  "--windows-description=RaceIQ",
  `--windows-version=${version}`,
  "--external",
  "@duckdb/node-bindings-*",
  "--define",
  'process.env.NODE_ENV="production"',
  ...featureDefines,
  "apps/backend/src/bootstrap.ts",
  "server/experiments/lap-issues-worker.ts",
  "apps/backend/src/runtime/startup-worker-entry.ts",
  "packages/capture-splitting/src/worker.ts",
  "packages/capture-formats/src/session/source-writer-worker.ts",
  "apps/backend/src/session-capture/live-worker-entry.ts",
  "server/session-capture/lmu-opponent-index-worker.ts",
  "--outfile",
  "dist/raceiq.exe",
], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production" },
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`Release server compile failed with exit code ${exitCode}`);
