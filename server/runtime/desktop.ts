import { spawn } from "node:child_process";
import { IS_DARWIN, IS_WINDOWS } from "./platform/shell";

export function preventMacSleep(): void {
  if (!IS_DARWIN) return;
  try {
    const caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: true });
    caffeinate.unref();
    process.on("exit", () => {
      try {
        caffeinate.kill();
      } catch {}
    });
    console.log("[Server] caffeinate started — macOS will not sleep while server is running");
  } catch {
    console.log("[Server] caffeinate not available — sleep prevention disabled");
  }
}

export function openFirstRunDashboard(port: number): void {
  // Installed shortcuts wait for HTTP readiness and open the dashboard themselves.
  if (process.env.RACEIQ_LAUNCHER_OPENS_BROWSER === "1") return;
  const host = IS_WINDOWS ? "raceiq.localhost" : "localhost";
  const url = `http://${host}${port === 80 ? "" : `:${port}`}`;
  console.log(`[Server] First run detected — opening ${url}`);
  try {
    if (IS_WINDOWS) {
      spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true }).unref();
    } else if (IS_DARWIN) {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}
