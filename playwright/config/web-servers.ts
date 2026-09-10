import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { E2ERuntime, ServerPorts } from "./runtime";

type WebServerDefinition = {
  command: string;
  env: Record<string, string>;
  url: string;
  timeout: number;
  reuseExistingServer: false;
  stdout: "pipe";
  stderr: "pipe";
};
function loadDevelopmentEnv(): Record<string, string> {
  const path = resolve(process.cwd(), "..", ".env.development");
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const developmentEnv = loadDevelopmentEnv();

function serverDefinition(runtime: E2ERuntime, ports: ServerPorts, seeded: boolean, seedSetupData = false): WebServerDefinition {
  const command = runtime.devServer ? "bun support/server/start-dev-server.ts" : "bun support/server/start-server.ts";
  const env: Record<string, string> = {
    ...developmentEnv,
    DATA_DIR: ports.dataDir,
    SERVER_PORT: ports.port,
    UDP_PORT: ports.udpPort,
    NODE_ENV: runtime.devServer ? "test" : "production",
    RACEIQ_SETUP_HOME: resolve(ports.dataDir, "setup-home"),
    RACEIQ_SEED_SETUP_DATA: seedSetupData ? "1" : "0",
  };
  if (runtime.devServer) {
    env.CLIENT_PORT = ports.clientPort;
    if (runtime.appRoot) env.RACEIQ_APP_ROOT = runtime.appRoot;
  }
  if (seeded) {
    env.PW_SEED_SCREENSHOTS = "1";
    env.RACEIQ_E2E = "1";
  }

  return {
    command,
    env,
    url: `http://localhost:${runtime.devServer ? ports.clientPort : ports.port}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  };
}

export function createWebServers(runtime: E2ERuntime): WebServerDefinition[] {
  const servers: WebServerDefinition[] = [];
  if (runtime.needsFreshServer) servers.push(serverDefinition(runtime, runtime.freshInstall, false));
  if (!runtime.screenshotOnly && runtime.needsTunesServer) {
    servers.push(serverDefinition(runtime, runtime.tunes, true, true));
  }
  if (!runtime.screenshotOnly && runtime.needsTunesUnseededServer) {
    servers.push(serverDefinition(runtime, runtime.tunesUnseeded, false));
  }
  if (runtime.needsSeededServer) servers.push(serverDefinition(runtime, runtime.seeded, true));
  return servers;
}
