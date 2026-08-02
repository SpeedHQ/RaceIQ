import { execFileSync, spawnSync } from "child_process";

export const IS_WINDOWS = process.platform === "win32";
export const IS_DARWIN = process.platform === "darwin";

export function runPowerShellCommand(command: string, timeoutMs?: number): string {
  const output = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    timeoutMs ? { encoding: "utf8", timeout: timeoutMs } : { encoding: "utf8" },
  );
  return output.stdout.toString().trim();
}

export function runPowerShellScript(scriptPath: string, args: string[] = [], timeoutMs = 5000): string {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ],
    { encoding: "utf-8", windowsHide: true, timeout: timeoutMs },
  ).trim();
}
