import { rmSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { spawn } from "child_process";
import { seedScreenshotData } from "./seed-screenshot-data";

// Cross-platform launcher for Playwright projects that target the compiled
// raceiq binary.
//
// 1. Wipes the DATA_DIR passed in from playwright.config.ts (defaults to
//    playwright/test-data for the fresh-install project) and seeds
//    settings.json so the server reads a fresh state at startup:
//      - udpPort: non-default (avoids colliding with a running dev server) —
//        controlled by UDP_PORT env var so multiple projects can run in
//        parallel without fighting for the same socket.
//      - settings.json existence: skips the binary's first-run "open browser"
//        branch (spawn("open") currently kills the compiled macOS binary)
//      - onboardingComplete is left unset → schema default false → wizard shows
// 2. Spawns the compiled binary (raceiq / raceiq.exe) with its stdio wired
//    through so Playwright sees the server logs in its webServer output.
// 3. Forwards SIGTERM/SIGINT so Playwright can clean the server up between runs.

const dir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(__dirname, "test-data");
const udpPort = Number(process.env.UDP_PORT ?? 15318);
const repoDir = resolve(__dirname, "..");

// Guard against a misconfigured DATA_DIR pointing at real user data — this
// directory gets wiped unconditionally on every run.
const dirSegments = dir.split(/[\\/]+/);
if (!dirSegments.some((segment) => segment.includes("test-data"))) {
  throw new Error(
    `Refusing to wipe DATA_DIR "${dir}": path must contain a "test-data" segment.`,
  );
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "settings.json"), JSON.stringify({ udpPort }));
seedScreenshotData(repoDir, dir);

const binaryName = process.platform === "win32" ? "raceiq.exe" : "raceiq";
const distDir = resolve(__dirname, "..", "dist");
const binary = resolve(distDir, binaryName);

// cwd = dist/ so the binary resolves its native libsql addon from
// dist/node_modules/@libsql/<target> — native .node modules can't be embedded
// in a Bun single-file executable (oven-sh/bun#18909). This matches the
// installed layout, where raceiq.exe sits next to node_modules/.
const child = spawn(binary, { stdio: "inherit", cwd: distDir, env: process.env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
const forward = (sig: NodeJS.Signals) => child.kill(sig);
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));
