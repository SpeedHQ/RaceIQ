import { spawnSync } from "child_process";
import { join } from "path";
import { dirname } from "path";

const REG_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "RaceIQ";

export function isLaunchOnLoginEnabled(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue).${VALUE_NAME}`],
      { encoding: "utf8" },
    );
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function enableLaunchOnLogin(exeDir: string): void {
  if (process.platform !== "win32") return;
  const launcherPath = join(exeDir, "raceiq-launcher.vbs");
  const value = `wscript "${launcherPath}"`;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Set-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -Value '${value.replace(/'/g, "''")}'`],
    { encoding: "utf8" },
  );
}

export function disableLaunchOnLogin(): void {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Remove-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue`],
    { encoding: "utf8" },
  );
}

export function getLaunchOnLoginExeDir(): string {
  return dirname(process.execPath);
}
