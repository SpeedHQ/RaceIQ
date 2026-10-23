import { fileURLToPath } from "node:url";

const [kind, ...args] = Bun.argv.slice(2);
const flags = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
  RACEIQ_FEATURE_IRACING_ADAPTER: "true",
};
const root = fileURLToPath(new URL("..", import.meta.url));
const run = (command: string[], env: Record<string, string>) => {
  const result = Bun.spawnSync(command, { cwd: root, env: { ...process.env, ...flags, ...env }, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
};
run(["bun", "run", "build:browser"], flags);
if (kind === "screenshots") {
  run(["bunx", "playwright", "test", "--config=playwright/responsive-screenshots.config.ts", ...args], {
    E2E_SERVER_MODE: "compiled", PW_SERVER_SET: "seeded", PW_SCREENSHOT_ONLY: "1", PW_SEED_SCREENSHOTS: "1",
  });
} else {
  const projects: Record<string, string[]> = {
    e2e: ["--workers=1", "--project=fresh-install", "--project=tunes", "--project=tunes-unseeded", "--project=seeded-e2e", "--project=seeded-routes", "--project=seeded-imports", "--project=seeded-webgpu", "--project=tracks-catalogue", "--project=cars-catalogue", "--project=online"],
    fresh: ["--project=fresh-install", "--max-failures=1"],
    tunes: ["--project=tunes", "--max-failures=1"],
    seeded: ["--project=seeded-e2e", "--project=seeded-webgpu", "--project=cars-catalogue", "--project=online", "--max-failures=1"],
  };
  if (!kind || !projects[kind]) throw new Error(`Unknown browser verification kind: ${kind}`);
  run(["bunx", "turbo", "run", "test", "--filter=raceiq-e2e", "--", ...projects[kind], ...args], {
    E2E_SERVER_MODE: "compiled", PW_SERVER_SET: kind === "e2e" ? "all" : kind,
  });
}
