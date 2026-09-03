import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { resetTestDatabase } from "./reset-test-database";
import { seedE2ESetupData, seedScreenshotData } from "./seed-screenshot-data";

// Cross-platform launcher for Playwright projects that target the compiled
// raceiq binary.
//
// 1. Ensures the DATA_DIR exists and seeds settings.json so the server reads
//    deterministic test settings at startup:
//      - udpPort: non-default (avoids colliding with a running dev server) —
//        controlled by UDP_PORT env var so multiple projects can run
//        in parallel without fighting for the same socket.
//      - settings.json existence: skips the binary's first-run "open browser"
//        branch (spawn("open") currently kills the compiled macOS binary)
//      - onboardingComplete is left unset → schema default false → wizard shows
// 2. Spawns the compiled binary (raceiq / raceiq.exe) with its stdio wired
//    through so Playwright sees the server logs in its webServer output.
// 3. Forwards SIGTERM/SIGINT so Playwright can clean the server up between runs.

const repoDir = resolve(__dirname, "..", "..", "..");
const dir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(repoDir, "playwright", "test-data");
const udpPort = Number(process.env.UDP_PORT ?? 15318);
const binaryName = process.platform === "win32" ? "raceiq.exe" : "raceiq";
const distDir = resolve(repoDir, "dist");
const binary = resolve(distDir, binaryName);

if (!existsSync(binary)) {
  throw new Error(`Compiled E2E server binary not found at "${binary}". Run "bun run build" first.`);
}
resetTestDatabase(dir);
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "settings.json"), JSON.stringify({ udpPort }));
if (process.env.RACEIQ_SEED_SETUP_DATA === "1") seedE2ESetupData(repoDir, dir);
seedScreenshotData(repoDir, dir);

// cwd = dist/ so the binary resolves its native libsql addon from
// dist/node_modules/@libsql/<target> — native .node modules can't be embedded
// in a Bun single-file executable (oven-sh/bun#18909). This matches the
// installed layout, where raceiq.exe sits next to node_modules/.
const child = spawn(binary, {
  stdio: "inherit",
  cwd: distDir,
  env: { ...process.env, RACEIQ_APP_ROOT: repoDir },
});

child.on("error", (error) => {
  console.error(`[E2E] Failed to start compiled server: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

let shuttingDown = false;
const forward = (sig: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill(sig);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));
