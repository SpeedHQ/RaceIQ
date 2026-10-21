/**
 * Secure credential store — uses the OS keychain:
 *   macOS:   Keychain via `security` CLI
 *   Windows: Credential Manager via PowerShell
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { IS_COMPILED } from "../config/paths";
import { IS_DARWIN, IS_WINDOWS, runPowerShellScript } from "./shell";
import { createMacKeychain } from "./mac-keychain";

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
const WIN_STORE_AVAILABLE = IS_WINDOWS && existsSync(SCRIPT_PATH);

let warnedUnavailable = false;
function warnUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    `[Keystore] Credential store unavailable (platform=${process.platform}, script=${SCRIPT_PATH} ${existsSync(SCRIPT_PATH) ? "present" : "missing"}). Secrets will not be persisted.`,
  );
}

function ps(args: string[]): string {
  return runPowerShellScript(SCRIPT_PATH, args);
}

// ── macOS helpers ────────────────────────────────────────────

const macKeychain = createMacKeychain();

// ── Public API ───────────────────────────────────────────────

export async function getSecret(key: string): Promise<string> {
  if (IS_DARWIN) {
    try { return macKeychain.get(key); } catch { return ""; }
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
  if (IS_DARWIN) {
    if (!value) {
      macKeychain.delete(key);
    } else {
      macKeychain.set(key, value);
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
