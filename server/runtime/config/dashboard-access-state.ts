import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const CONFIGURED = "raceiq-dashboard-access-v1\n";
export const dashboardAccessMarkerPath = (databasePath: string) => `${databasePath}.dashboard-access`;

/** A non-secret witness survives loss/replacement of the credential database. */
export function dashboardAccessWasConfigured(databasePath: string): boolean {
  const path = dashboardAccessMarkerPath(databasePath);
  if (!existsSync(path)) return false;
  if (readFileSync(path, "utf8") !== CONFIGURED) throw new Error("Dashboard access marker is corrupt; restore the access configuration from backup");
  return true;
}

export function assertDashboardDatabasePresent(databasePath: string) {
  if (dashboardAccessWasConfigured(databasePath) && !existsSync(databasePath)) {
    throw new Error("Previously configured dashboard database is missing; restore the access configuration from backup");
  }
}

export function markDashboardAccessConfigured(databasePath: string) {
  const path = dashboardAccessMarkerPath(databasePath);
  if (dashboardAccessWasConfigured(databasePath)) return;
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, CONFIGURED);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Temporary marker was not published.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && dashboardAccessWasConfigured(databasePath)) return;
    throw error;
  }
}
