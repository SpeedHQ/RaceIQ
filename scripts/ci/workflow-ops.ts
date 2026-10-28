import { tmpdir } from "node:os";
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [operation, ...args] = Bun.argv.slice(2);
const env = process.env;
// Responsive cases exercise these five games; both revisions use same seed set.
const RESPONSIVE_SCREENSHOT_GAMES = "fm-2023,f1-2025,acc,ac-evo,iracing";

function run(command: string[], cwd = process.cwd(), extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...env, ...extraEnv },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

function summary(text: string) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) throw new Error("GITHUB_STEP_SUMMARY is required");
  appendFileSync(path, `${text}\n`);
}

switch (operation) {
  case "install-retry": {
    const cwd = args[0] ?? process.cwd();
    const first = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd, env, stdout: "inherit", stderr: "inherit" });
    if (first.exitCode === 0) break;
    rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
    run(["bun", "install", "--frozen-lockfile", "--force"], cwd);
    break;
  }
  case "bench-install":
    run(["bun", "install", "--frozen-lockfile"], "pr");
    run(["bun", "install", "--no-save", "--ignore-scripts"], "base");
    mkdirSync("reports", { recursive: true });
    break;
  case "bench-run":
    run(["bun", "run", "scripts/quality/run-bench-ci.ts", "--base=../base", "--current=.", "--reports=../reports"], "pr");
    break;
  case "native-summary":
    summary(`## Native capture status\n\nCommitted replay lane ran for \`${env.GAME}\`.\n\nPhysical blocker: GitHub-hosted Windows runner has no installed game process, UDP/shared-memory telemetry provider, wheel hardware, or provider permissions. True unattended ACC, AC Evo, and iRacing capture (plus F1/FM UDP capture) cannot run here; this lane intentionally replays committed recordings only.`);
    break;
  case "add-worktree":
    run(["git", "worktree", "add", "--detach", join(env.RUNNER_TEMP!, "raceiq-base"), env.BASE_SHA!]);
    break;
  case "screenshot-current": {
    run(["bun", "run", "build"], process.cwd(), { RACEIQ_FEATURE_F1_EXPERIMENTS: "true", RACEIQ_FEATURE_IRACING_ADAPTER: "true" });
    const status = Bun.spawnSync(["bun", "run", "../scripts/playwright-ci.ts", "test", "--config=responsive-screenshots.config.ts", `--shard=${env.SHARD}/4`], {
      cwd: "playwright",
      env: { ...env, E2E_SERVER_MODE: "compiled", RACEIQ_FEATURE_F1_EXPERIMENTS: "true", RACEIQ_FEATURE_IRACING_ADAPTER: "true", PW_SCREENSHOT_WORKERS: "1", PW_SERVER_SET: "seeded", PW_SCREENSHOT_ONLY: "1", PW_SEED_SCREENSHOTS: "1", PW_SEED_GAMES: RESPONSIVE_SCREENSHOT_GAMES },
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode;
    const screenshots = join("playwright", "screenshots", "mobile");
    const output = join(env.RUNNER_TEMP!, "current-responsive");
    rmSync(output, { recursive: true, force: true });
    if (existsSync(screenshots)) {
      cpSync(screenshots, output, { recursive: true });
      rmSync(screenshots, { recursive: true, force: true });
    }
    if (status !== 0) process.exit(status);
    break;
  }
  case "screenshot-base": {
    const base = join(env.RUNNER_TEMP!, "raceiq-base");
    if (!existsSync(base)) throw new Error(`Base comparison worktree is missing: ${base}`);
    run(["bun", "install"], base);
    run(["bun", "run", "build"], base, { RACEIQ_FEATURE_F1_EXPERIMENTS: "true", RACEIQ_FEATURE_IRACING_ADAPTER: "true" });
    const current = env.GITHUB_WORKSPACE!;
    const basePlaywright = join(base, "playwright");
    const output = join(current, "playwright/screenshots/mobile");
    const config = join(basePlaywright, "responsive-screenshots.config.ts");
    // Keep baseline-owned cases and helpers compatible with its historical API.
    writeFileSync(config, `
      import { devices, defineConfig } from "@playwright/test";
      import { runtime } from ${JSON.stringify(join(current, "playwright/config/runtime.ts"))};
      import { createWebServers } from ${JSON.stringify(join(current, "playwright/config/web-servers.ts"))};
      export default defineConfig({
        testDir: "tests/responsive",
        testMatch: "mobile-screenshots.spec.ts",
        outputDir: "./test-results/mobile-screenshots",
        fullyParallel: runtime.parallelScreenshotRun,
        workers: runtime.screenshotWorkers,
        retries: process.env.CI ? 1 : 0,
        reporter: process.env.CI ? [["list"], ["github"]] : "list",
        timeout: 50_000,
        expect: { timeout: 10_000 },
        use: { ...devices["Desktop Chrome"], baseURL: \`http://localhost:\${runtime.seeded.port}\`, ignoreHTTPSErrors: true, colorScheme: "dark", actionTimeout: 10_000, navigationTimeout: 30_000, trace: "retain-on-failure" },
        webServer: createWebServers(runtime),
      });
    `);
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    const status = Bun.spawnSync([
      "bun", "run", join(current, "scripts/playwright-ci.ts"), "test",
      `--config=${config}`, `--shard=${env.SHARD}/4`,
    ], {
      cwd: basePlaywright,
      env: { ...env, RACEIQ_APP_ROOT: base, RACEIQ_SCREENSHOT_DIR: output, E2E_SERVER_MODE: "compiled", RACEIQ_FEATURE_F1_EXPERIMENTS: "true", RACEIQ_FEATURE_IRACING_ADAPTER: "true", PW_SCREENSHOT_WORKERS: "1", PW_SERVER_SET: "seeded", PW_SCREENSHOT_ONLY: "1", PW_SEED_SCREENSHOTS: "1", PW_SEED_GAMES: RESPONSIVE_SCREENSHOT_GAMES },
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode;
    const saved = join(env.RUNNER_TEMP!, "base-responsive");
    rmSync(saved, { recursive: true, force: true });
    if (existsSync(output)) cpSync(output, saved, { recursive: true });
    rmSync(config, { force: true });
    if (status !== 0) process.exit(status ?? 1);
    break;
  }
  case "save-render": {
    const artifact = join(env.RUNNER_TEMP!, `screenshot-render-${env.SHARD}`);
    mkdirSync(artifact, { recursive: true });
    for (const name of ["current-responsive", "base-responsive"]) {
      const source = join(env.RUNNER_TEMP!, name);
      if (existsSync(source)) cpSync(source, join(artifact, name), { recursive: true });
    }
    writeFileSync(join(artifact, "current-status.txt"), env.CURRENT_STATUS ?? "");
    writeFileSync(join(artifact, "base-status.txt"), env.BASE_STATUS ?? "");
    writeFileSync(join(artifact, "pr-number.txt"), env.PR_NUMBER ?? "");
    writeFileSync(join(artifact, "base-ref.txt"), env.BASE_REF ?? "");
    break;
  }
  case "fail-render":
    if (env.CURRENT_STATUS !== "success" || env.BASE_STATUS !== "success") {
      console.error("Responsive screenshot comparison unavailable: current or base capture failed; saved shard status is evidence, not a comparison.");
      process.exitCode = 1;
    }
    break;
  case "collect-screenshots": {
    const preview = join(env.GITHUB_WORKSPACE!, "pr-preview");
    run(["bun", "packages/tooling-ui/src/ui/merge-screenshot-renders.ts", "--input", join(env.RUNNER_TEMP!, "screenshot-renders"), "--output", preview]);
    break;
  }
  case "release-client":
    run(["bun", "install"], "client");
    run(["bun", "run", "build"], "client");
    break;
  case "prepare-dist":
    mkdirSync("dist", { recursive: true });
    break;
  case "copy-client":
    cpSync("client/dist", "dist/public", { recursive: true });
    break;
  case "copy-addon": {
    mkdirSync("dist/node_modules/@libsql/win32-x64-msvc", { recursive: true });
    for (const file of ["index.node", "package.json"]) {
      cpSync(`node_modules/@libsql/win32-x64-msvc/${file}`, `dist/node_modules/@libsql/win32-x64-msvc/${file}`);
    }
    run(["bun", "packages/tooling-build/src/build/copy-duckdb-runtime.ts"]);
    break;
  }
  case "patch-pe": {
    const rcedit = join(env.TEMP ?? env.RUNNER_TEMP ?? tmpdir(), "rcedit.exe");
    const response = await fetch("https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe");
    if (!response.ok) throw new Error(`rcedit download failed: ${response.status}`);
    await Bun.write(rcedit, response);
    run([rcedit, "dist/raceiq.exe", "--set-version-string", "ProductName", "RaceIQ", "--set-version-string", "InternalName", "RaceIQ"]);
    break;
  }
  case "smoke-server": {
    const executable = join(process.cwd(), "dist", "raceiq.exe");
    const server = Bun.spawn([executable], { cwd: "dist", stdout: "inherit", stderr: "inherit" });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (server.exitCode !== null) throw new Error(`RaceIQ exited during startup with code ${server.exitCode}`);
        try {
          const response = await fetch("http://127.0.0.1:3117/");
          if (response.ok || response.status < 500) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(1000);
      }
      if (!ready) throw new Error("RaceIQ did not listen on port 3117 within 30 seconds");
    } finally {
      server.kill();
    }
    break;
  }
  case "install-inno": {
    const installer = join(env.TEMP ?? env.RUNNER_TEMP ?? tmpdir(), "innosetup.exe");
    const response = await fetch("https://github.com/jrsoftware/issrc/releases/download/is-6_7_1/innosetup-6.7.1.exe");
    if (!response.ok) throw new Error(`Inno Setup download failed: ${response.status}`);
    await Bun.write(installer, response);
    run([installer, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/DIR=C:\\InnoSetup"]);
    if (env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, "C:\\InnoSetup\n");
    break;
  }
  case "safe-git":
    run(["git", "config", "--global", "--add", "safe.directory", env.GITHUB_WORKSPACE ?? process.cwd()]);
    break;
  case "release-summary":
    summary(env.SKIP_TESTS === "true" ? "## Release test mode\n\nPlaywright tests skipped by manual dispatch input after local verification." : "## Release test mode\n\nPlaywright tests enabled.");
    break;
  default:
    throw new Error(`Unknown workflow operation: ${operation}`);
}
