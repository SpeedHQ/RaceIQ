import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { IS_COMPILED } from "./paths";

const REG_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "RaceIQ";

export function isLaunchOnLoginEnabled(): boolean {
  if (process.platform !== "win32" || !IS_COMPILED) return false;
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
  if (process.platform !== "win32" || !IS_COMPILED) return;
  const exePath = join(exeDir, "raceiq.exe");
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Set-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -Value '"${exePath}"'`],
    { encoding: "utf8" },
  );
}

export function disableLaunchOnLogin(): void {
  if (process.platform !== "win32" || !IS_COMPILED) return;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Remove-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue`],
    { encoding: "utf8" },
  );
}

export function getLaunchOnLoginExeDir(): string {
  return dirname(process.execPath);
}
