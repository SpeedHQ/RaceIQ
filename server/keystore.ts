/**
 * Secure credential store — uses the OS keychain:
 *   macOS:   Keychain via `security` CLI
 *   Windows: Credential Manager via PowerShell
 */
import { execFileSync, execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { IS_COMPILED } from "./paths";

const IS_MAC = process.platform === "darwin";
const SERVICE = "RaceIQ";

// ── Windows helpers ──────────────────────────────────────────

const SCRIPT_PATH = IS_COMPILED
  ? resolve(dirname(process.execPath), "credstore.ps1")
  : resolve(dirname(fileURLToPath(import.meta.url)), "credstore.ps1");

/**
 * True when the Windows credential store is usable. On non-Windows (and in
 * stripped-down dist layouts where credstore.ps1 wasn't packaged) there is no
 * point shelling out to PowerShell — bail out instead of retrying and spamming
 * warnings on every settings read.
 */
const WIN_STORE_AVAILABLE = process.platform === "win32" && existsSync(SCRIPT_PATH);

let warnedUnavailable = false;
function warnUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    `[Keystore] Credential store unavailable (platform=${process.platform}, script=${SCRIPT_PATH} ${existsSync(SCRIPT_PATH) ? "present" : "missing"}). Secrets will not be persisted.`,
  );
}

function ps(args: string[]): string {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, ...args],
    { encoding: "utf-8", windowsHide: true, timeout: 5000 },
  ).trim();
}

// ── macOS helpers ────────────────────────────────────────────

function macGet(account: string): string {
  return execSync(
    `security find-generic-password -s "${SERVICE}" -a "${account}" -w 2>/dev/null`,
    { encoding: "utf-8", timeout: 5000 },
  ).trim();
}

function macSet(account: string, password: string): void {
  // Delete first to avoid "already exists" error, then add
  try { execSync(`security delete-generic-password -s "${SERVICE}" -a "${account}" 2>/dev/null`, { timeout: 5000 }); } catch { /* ok if missing */ }
  execSync(
    `security add-generic-password -s "${SERVICE}" -a "${account}" -w "${password.replace(/"/g, '\\"')}"`,
    { timeout: 5000 },
  );
}

function macDelete(account: string): void {
  execSync(
    `security delete-generic-password -s "${SERVICE}" -a "${account}" 2>/dev/null`,
    { timeout: 5000 },
  );
}

// ── Public API ───────────────────────────────────────────────

export async function getSecret(key: string): Promise<string> {
  if (IS_MAC) {
    try { return macGet(key); } catch { return ""; }
  }
  if (!WIN_STORE_AVAILABLE) { warnUnavailableOnce(); return ""; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tmpFile = join(tmpdir(), `raceiq-cred-${process.pid}-${key}-${randomUUID()}`);
      ps(["read", `${SERVICE}:${key}`, "", tmpFile]);
      const value = readFileSync(tmpFile, "utf-8");
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      return value;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[Keystore] Failed to read ${key}:`, err instanceof Error ? err.message : String(err));
        return "";
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  return "";
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (IS_MAC) {
    if (!value) {
      macDelete(key);
    } else {
      macSet(key, value);
    }
    return;
  }
  if (!WIN_STORE_AVAILABLE) { warnUnavailableOnce(); return; }
  if (!value) {
    ps(["delete", `${SERVICE}:${key}`]);
  } else {
    ps(["write", `${SERVICE}:${key}`, value]);
  }
}

export async function deleteSecret(key: string): Promise<void> {
  if (IS_MAC) { macDelete(key); return; }
  if (!WIN_STORE_AVAILABLE) { warnUnavailableOnce(); return; }
  ps(["delete", `${SERVICE}:${key}`]);
}
