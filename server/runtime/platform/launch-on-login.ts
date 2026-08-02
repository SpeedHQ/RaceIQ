import { dirname, join } from "path";
import { IS_COMPILED } from "../config/paths";
import { IS_WINDOWS, runPowerShellCommand } from "./shell";

const REG_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const VALUE_NAME = "RaceIQ";

// StartupApproved binary values used by Windows (same format as Task Manager)
const ENABLED_BYTES = "02,00,00,00,00,00,00,00,00,00,00,00";
const DISABLED_BYTES = "03,00,00,00,00,00,00,00,00,00,00,00";

export function isLaunchOnLoginEnabled(): boolean {
  if (!IS_WINDOWS || !IS_COMPILED) return false;
  try {
    // Entry must exist in Run key
    const exists = runPowerShellCommand(`(Get-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue).${VALUE_NAME}`);
    if (!exists) return false;
    // Check StartupApproved — if present, first byte must be 0x02 (enabled)
    const approved = runPowerShellCommand(`$v = (Get-ItemProperty -Path '${APPROVED_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue).${VALUE_NAME}; if ($v) { $v[0] } else { 2 }`);
    return approved !== "3";
  } catch {
    return false;
  }
}

export function enableLaunchOnLogin(exeDir: string): void {
  if (!IS_WINDOWS || !IS_COMPILED) return;
  const exePath = join(exeDir, "raceiq.exe");
  runPowerShellCommand(`Set-ItemProperty -Path '${REG_PATH}' -Name '${VALUE_NAME}' -Value '"${exePath}"'`);
  runPowerShellCommand(`$bytes = [byte[]](${ENABLED_BYTES} -split ',' | ForEach-Object { [Convert]::ToByte($_.Trim(), 16) }); New-ItemProperty -Path '${APPROVED_PATH}' -Name '${VALUE_NAME}' -Value $bytes -PropertyType Binary -Force | Out-Null`);
}

export function disableLaunchOnLogin(): void {
  if (!IS_WINDOWS || !IS_COMPILED) return;
  // Keep the Run entry but mark as disabled in StartupApproved (same as Task Manager disable)
  runPowerShellCommand(`$bytes = [byte[]](${DISABLED_BYTES} -split ',' | ForEach-Object { [Convert]::ToByte($_.Trim(), 16) }); New-ItemProperty -Path '${APPROVED_PATH}' -Name '${VALUE_NAME}' -Value $bytes -PropertyType Binary -Force | Out-Null`);
}

export function getLaunchOnLoginExeDir(): string {
  return dirname(process.execPath);
}
