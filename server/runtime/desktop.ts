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

export function openDashboard(url: string, route = "/"): void {
  let destination: URL;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return;
    destination = new URL(route, parsed.origin);
    if (destination.origin !== parsed.origin || destination.username || destination.password) return;
    for (const character of route) {
      const code = character.charCodeAt(0);
      if (character === "\\" || code <= 0x1f || code === 0x7f) return;
    }
  } catch {
    return;
  }
  console.log(`[Server] Opening dashboard at ${destination.origin}`);
  try {
    if (IS_WINDOWS) {
      spawn("cmd", ["/c", "start", "", destination.href], { stdio: "ignore", detached: true }).unref();
    } else if (IS_DARWIN) {
      spawn("open", [destination.href], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [destination.href], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}

export function openFirstRunDashboard(port: number): void {
  // Installed shortcuts wait for HTTP readiness and open the dashboard themselves.
  if (process.env.RACEIQ_LAUNCHER_OPENS_BROWSER === "1") return;
  openDashboard(`http://localhost:${port}`);
}
