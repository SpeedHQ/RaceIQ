import { fileURLToPath } from "node:url";

const env = {
  ...process.env,
  RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
  RACEIQ_FEATURE_IRACING_ADAPTER: "true",
};
const result = Bun.spawnSync(["bunx", "turbo", "run", "build"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode ?? 1);
