import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { resolve } from "node:path";

async function availableTcpPort(): Promise<string> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "0.0.0.0", resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate E2E TCP port");
  const port = String(address.port);
  const { promise: closePromise, resolve: closeResolve, reject: closeReject } = Promise.withResolvers<void>();
  server.close(error => error ? closeReject(error) : closeResolve());
  await closePromise;
  return port;
}

async function availableUdpPort(): Promise<string> {
  const socket = createSocket("udp4");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  socket.once("error", reject);
  socket.bind(0, "0.0.0.0", () => {
    const port = String(socket.address().port);
    socket.close(() => resolve(port));
  });
  return promise;
}

async function playwrightPortEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const reserve = async (names: string[], allocate: () => Promise<string>) => {
    const used = new Set(names.map(name => process.env[name]).filter((port): port is string => port !== undefined));
    for (const name of names) {
      if (process.env[name] !== undefined) continue;
      let port: string;
      do port = await allocate(); while (used.has(port));
      used.add(port);
      env[name] = port;
    }
  };

  await reserve(
    ["PW_FRESH_INSTALL_PORT", "PW_TUNES_PORT", "PW_TUNES_UNSEEDED_PORT", "PW_SEEDED_E2E_PORT"],
    availableTcpPort,
  );
  await reserve(
    ["PW_FRESH_INSTALL_UDP_PORT", "PW_TUNES_UDP_PORT", "PW_TUNES_UNSEEDED_UDP_PORT", "PW_SEEDED_E2E_UDP_PORT"],
    availableUdpPort,
  );
  return env;
}

const root = new URL("../..", import.meta.url).pathname;
const seededDataDir = resolve(root, "playwright/test-data-seed-producer");
const seededDatabase = resolve(seededDataDir, "app.db");
const suites = [
  { name: "release build", args: ["run", "build"] },
  { name: "unit", args: ["run", "test:unit"] },
  { name: "tooling", args: ["run", "test:tooling"] },
  { name: "integration", args: ["run", "test:integration"] },
  { name: "recording E2E", args: ["run", "test:e2e:recordings"] },
  { name: "prepare Playwright E2E database", args: ["playwright/support/server/prepare-seeded-database.ts"], env: { DATA_DIR: seededDataDir } },
  { name: "Playwright E2E", args: ["scripts/test/run-turbo.ts", "test", "--filter=raceiq-e2e"], env: { E2E_SERVER_MODE: "compiled", PW_SERVER_SET: "all", PW_SEEDED_DATABASE: seededDatabase } },
];
const failures: string[] = [];

for (const suite of suites) {
  console.log(`\n=== Running ${suite.name} tests ===`);
  const portEnv = suite.name === "Playwright E2E" ? await playwrightPortEnv() : {};
  const result = Bun.spawnSync([process.execPath, ...suite.args], {
    cwd: root,
    env: { ...process.env, ...suite.env, ...portEnv },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) failures.push(`${suite.name} (exit ${result.exitCode ?? "signal"})`);
}

if (failures.length > 0) {
  console.error(`\nFailed test suites: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll test suites passed.");
