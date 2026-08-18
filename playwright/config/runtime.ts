import { resolve } from "node:path";

export type E2EServerMode = "dev" | "compiled";
export type E2EServerSet = "all" | "fresh" | "tunes" | "tunes-unseeded" | "seeded";

export interface E2ERuntime {
  serverMode: E2EServerMode;
  serverSet: E2EServerSet;
  devServer: boolean;
  screenshotOnly: boolean;
  seededScreenshots: boolean;
  parallelScreenshotRun: boolean;
  screenshotWorkers: number;
  testWorkers: number;
  appRoot?: string;
  needsFreshServer: boolean;
  needsTunesServer: boolean;
  needsTunesUnseededServer: boolean;
  needsSeededServer: boolean;
  freshInstall: ServerPorts;
  tunes: ServerPorts;
  tunesUnseeded: ServerPorts;
  seeded: ServerPorts;
}

export interface ServerPorts {
  port: string;
  clientPort: string;
  udpPort: string;
  dataDir: string;
}

function readServerMode(): E2EServerMode {
  const value = process.env.E2E_SERVER_MODE ?? "compiled";
  if (value !== "dev" && value !== "compiled") {
    throw new Error(`Unsupported E2E_SERVER_MODE "${value}" (expected dev or compiled)`);
  }
  return value;
}

function readServerSet(): E2EServerSet {
  const value = process.env.PW_SERVER_SET ?? "all";
  if (value !== "all" && value !== "fresh" && value !== "tunes" && value !== "tunes-unseeded" && value !== "seeded") {
    throw new Error(`Unsupported PW_SERVER_SET "${value}" (expected all, fresh, tunes, tunes-unseeded, or seeded)`);
  }
  return value;
}

function readPositiveWorkers(): number {
  const fallback = process.env.CI ? 2 : 4;
  const requested = Number.parseInt(process.env.PW_SCREENSHOT_WORKERS ?? String(fallback), 10);
  return Number.isFinite(requested) && requested > 0 ? requested : fallback;
}

function dataDir(value: string | undefined, fallback: string): string {
  return resolve(value ?? fallback);
}

const serverMode = readServerMode();
const serverSet = readServerSet();
const screenshotOnly = process.env.PW_SCREENSHOT_ONLY === "1";
const seededScreenshots = process.env.PW_SEED_SCREENSHOTS === "1";

const defaultTestWorkers = serverSet === "seeded" ? 2 : 1;
const requestedTestWorkers = Number.parseInt(process.env.PW_WORKERS ?? String(defaultTestWorkers), 10);
const testWorkers = Number.isFinite(requestedTestWorkers) && requestedTestWorkers > 0 ? requestedTestWorkers : defaultTestWorkers;

export const runtime: E2ERuntime = {
  serverMode,
  serverSet,
  devServer: serverMode === "dev",
  screenshotOnly,
  seededScreenshots,
  parallelScreenshotRun: screenshotOnly && seededScreenshots,
  screenshotWorkers: readPositiveWorkers(),
  testWorkers,
  ...(process.env.RACEIQ_APP_ROOT ? { appRoot: process.env.RACEIQ_APP_ROOT } : {}),
  needsFreshServer: serverSet === "all" || serverSet === "fresh",
  needsTunesServer: serverSet === "all" || serverSet === "tunes",
  needsTunesUnseededServer: serverSet === "all" || serverSet === "tunes-unseeded",
  needsSeededServer: serverSet === "all" || serverSet === "seeded",
  freshInstall: {
    port: process.env.PW_FRESH_INSTALL_PORT ?? "3118",
    clientPort: process.env.PW_FRESH_INSTALL_CLIENT_PORT ?? "4118",
    udpPort: process.env.PW_FRESH_INSTALL_UDP_PORT ?? "15318",
    dataDir: dataDir(process.env.PW_FRESH_INSTALL_DATA_DIR, resolve(__dirname, "..", "test-data")),
  },
  tunes: {
    port: process.env.PW_TUNES_PORT ?? "3119",
    clientPort: process.env.PW_TUNES_CLIENT_PORT ?? "4119",
    udpPort: process.env.PW_TUNES_UDP_PORT ?? "15319",
    dataDir: dataDir(process.env.PW_TUNES_DATA_DIR, resolve(__dirname, "..", "test-data-tunes")),
  },
  tunesUnseeded: {
    port: process.env.PW_TUNES_UNSEEDED_PORT ?? "3121",
    clientPort: process.env.PW_TUNES_UNSEEDED_CLIENT_PORT ?? "4121",
    udpPort: process.env.PW_TUNES_UNSEEDED_UDP_PORT ?? "15321",
    dataDir: dataDir(process.env.PW_TUNES_UNSEEDED_DATA_DIR, resolve(__dirname, "..", "test-results", "test-data-tunes-unseeded")),
  },
  seeded: {
    port: process.env.PW_SEEDED_E2E_PORT ?? "3120",
    clientPort: process.env.PW_SEEDED_E2E_CLIENT_PORT ?? "4120",
    udpPort: process.env.PW_SEEDED_E2E_UDP_PORT ?? "15320",
    dataDir: dataDir(process.env.PW_SEEDED_E2E_DATA_DIR, resolve(__dirname, "..", "test-results", "test-data-seeded")),
  },
};
