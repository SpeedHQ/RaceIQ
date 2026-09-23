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

function serverDefinition(runtime: E2ERuntime, ports: ServerPorts, seeded: boolean): WebServerDefinition {
  const command = runtime.devServer ? "bun support/server/start-dev-server.ts" : "bun support/server/start-server.ts";
  const env: Record<string, string> = {
    DATA_DIR: ports.dataDir,
    SERVER_PORT: ports.port,
    UDP_PORT: ports.udpPort,
    NODE_ENV: runtime.devServer ? "test" : "production",
    RACEIQ_SETUP_HOME: resolve(ports.dataDir, "setup-home"),
  };
  if (runtime.devServer) {
    env.CLIENT_PORT = ports.clientPort;
    if (runtime.appRoot) env.RACEIQ_APP_ROOT = runtime.appRoot;
  }
  if (seeded) {
    env.PW_SEED_SCREENSHOTS = "1";
    env.RACEIQ_E2E = "1";
    env.RACEIQ_FEATURE_F1_EXPERIMENTS = "true";
    env.RACEIQ_FEATURE_IRACING_ADAPTER = "true";
  }

  return {
    command,
    env,
    url: `http://localhost:${runtime.devServer ? ports.clientPort : ports.port}`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  };
}

export function createWebServers(runtime: E2ERuntime): WebServerDefinition[] {
  const servers: WebServerDefinition[] = [];
  if (runtime.needsFreshServer) servers.push(serverDefinition(runtime, runtime.freshInstall, false));
  if (!runtime.screenshotOnly && runtime.needsTunesServer) {
    servers.push(serverDefinition(runtime, runtime.tunes, true));
  }
  if (!runtime.screenshotOnly && runtime.needsTunesUnseededServer) {
    servers.push(serverDefinition(runtime, runtime.tunesUnseeded, false));
  }
  if (runtime.needsSeededServer) servers.push(serverDefinition(runtime, runtime.seeded, true));
  return servers;
}
