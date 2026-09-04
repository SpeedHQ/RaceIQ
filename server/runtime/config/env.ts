/** Environment utilities. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function loadPackagedEnv(): void {
  const path = join(dirname(process.execPath), ".env.production");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadPackagedEnv();

export const IS_DEV = process.env.NODE_ENV !== "production";
export const IS_E2E = process.env.RACEIQ_E2E === "1";
