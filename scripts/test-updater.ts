/**
 * Build installer then run dev server with update testing enabled.
 *
 * Usage: bun scripts/test-updater.ts
 *   1. Builds the full installer (client + server binary + Inno Setup)
 *   2. Starts dev server with DEV_FORCE_UPDATE=1 and LOCAL_INSTALLER pointed at the built exe
 *
 * The UI will show an update available. Clicking "Install Update" runs the local installer.
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const installerName = `RaceIQ-Setup-v${version}.exe`;

// Step 1: Build installer if it doesn't already exist
if (!existsSync(installerName)) {
  console.log(`\n→ Building installer (${installerName})...\n`);
  execSync("bun scripts/build-installer.ts", { stdio: "inherit" });
} else {
  console.log(`\n→ Installer already exists: ${installerName}\n`);
}

// Step 2: Run dev server with update testing env vars
console.log(`→ Starting dev server with DEV_FORCE_UPDATE=1 LOCAL_INSTALLER=${installerName}\n`);
execSync("bun run dev", {
  stdio: "inherit",
  env: {
    ...process.env,
    DEV_FORCE_UPDATE: "1",
    LOCAL_INSTALLER: installerName,
  },
});
