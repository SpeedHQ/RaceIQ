import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";

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
  if (dashboardAccessWasConfigured(databasePath)) return;
  let descriptor: number;
  try {
    descriptor = openSync(dashboardAccessMarkerPath(databasePath), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && dashboardAccessWasConfigured(databasePath)) return;
    throw error;
  }
  try {
    writeFileSync(descriptor, CONFIGURED);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
