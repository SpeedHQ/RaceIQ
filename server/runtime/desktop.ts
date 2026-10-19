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

export function openDashboard(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return;
  } catch {
    return;
  }
  console.log(`[Server] Opening dashboard at ${parsed.origin}`);
  try {
    if (IS_WINDOWS) {
      spawn("cmd", ["/c", "start", "", parsed.origin], { stdio: "ignore", detached: true }).unref();
    } else if (IS_DARWIN) {
      spawn("open", [parsed.origin], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [parsed.origin], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}

export function openFirstRunDashboard(port: number): void {
  openDashboard(`http://localhost:${port}`);
}
