import { spawn } from "child_process";
import { startTray } from "./platform/tray";

export function preventMacSleep(): void {
  if (process.platform !== "darwin") return;
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

export function startWindowsDesktop(port: number): void {
  if (process.platform === "win32") {
    startTray(port);
  }
}

export function openFirstRunDashboard(port: number): void {
  const url = `http://localhost:${port}`;
  console.log(`[Server] First run detected — opening ${url}`);
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}
