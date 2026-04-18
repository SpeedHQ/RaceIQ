import { rmSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { spawn } from "child_process";

// Cross-platform launcher for the fresh-install Playwright project.
//
// 1. Wipes playwright/test-data/ and seeds settings.json so the server
//    reads a fresh state at startup:
//      - udpPort: non-default (avoids colliding with a running dev server)
//      - settings.json existence: skips the binary's first-run "open browser"
//        branch (spawn("open") currently kills the compiled macOS binary)
//      - onboardingComplete is left unset → schema default false → wizard shows
// 2. Spawns the compiled binary (raceiq / raceiq.exe) with its stdio wired
//    through so Playwright sees the server logs in its webServer output.
// 3. Forwards SIGTERM/SIGINT so Playwright can clean the server up between runs.

const dir = resolve(__dirname, "test-data");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "settings.json"), JSON.stringify({ udpPort: 15318 }));

const binaryName = process.platform === "win32" ? "raceiq.exe" : "raceiq";
const binary = resolve(__dirname, "..", "dist", binaryName);

const child = spawn(binary, { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
const forward = (sig: NodeJS.Signals) => child.kill(sig);
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));
