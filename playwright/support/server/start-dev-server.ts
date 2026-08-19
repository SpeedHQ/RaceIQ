import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { seedScreenshotData } from "./seed-screenshot-data";

const repoDir = process.env.RACEIQ_APP_ROOT ? resolve(process.env.RACEIQ_APP_ROOT) : resolve(__dirname, "..", "..", "..");
const dir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(repoDir, "playwright", "test-data");
const serverPort = process.env.SERVER_PORT ?? "3118";
const trackRegistryDir = resolve(dir, "track-registry");
const clientPort = process.env.CLIENT_PORT ?? "4118";
const udpPort = process.env.UDP_PORT ?? "15318";

const dirSegments = dir.split(/[\\/]+/);
if (!dirSegments.some((segment) => segment.includes("test-data"))) {
  throw new Error(`Refusing to wipe DATA_DIR "${dir}": path must contain a "test-data" segment.`);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const tracksSource = resolve(repoDir, "shared", "data", "tracks");
const isolatedSourceDirectory = resolve(trackRegistryDir, "registry-source");
mkdirSync(isolatedSourceDirectory, { recursive: true });
for (const filename of ["configurations.json", "facts.json", "geometry.json", "verification.json"]) {
  cpSync(resolve(tracksSource, "registry-source", filename), resolve(isolatedSourceDirectory, filename));
}
cpSync(resolve(tracksSource, "registry.sqlite"), resolve(trackRegistryDir, "registry.sqlite"));
cpSync(resolve(tracksSource, "registry-report.json"), resolve(trackRegistryDir, "registry-report.json"));
writeFileSync(resolve(dir, "settings.json"), JSON.stringify({ udpPort: Number(udpPort) }));
seedScreenshotData(repoDir, dir);

const server = spawn("bun", ["run", "server/index.ts"], {
  cwd: repoDir,
  stdio: "inherit",
  env: { ...process.env, DATA_DIR: dir, RACEIQ_TRACK_REGISTRY_DIR: trackRegistryDir, SERVER_PORT: serverPort, UDP_PORT: udpPort },
});
const client = spawn("bun", ["run", "dev", "--", "--host", "0.0.0.0", "--port", clientPort], {
  cwd: resolve(repoDir, "client"),
  stdio: "inherit",
  env: {
    ...process.env,
    SERVER_PORT: serverPort,
    PROXY_TARGET: `http://127.0.0.1:${serverPort}`,
  },
});

const children: ChildProcess[] = [server, client];
let shuttingDown = false;

function stop(signal: NodeJS.Signals, exitCode?: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
  if (exitCode !== undefined) process.exitCode = exitCode;
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown) stop("SIGTERM", signal ? 1 : (code ?? 1));
  });
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
