import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { realpathSync } from "node:fs";
import { parseOnboardingOverride } from "../../server/runtime/options";

async function availableHttpPort(): Promise<number> {
  const server = createServer();
  try {
    return await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not allocate HTTP port"));
      });
    });
  } finally {
    server.close();
  }
}

async function availableUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "0.0.0.0", () => {
        const address = socket.address();
        resolve(address.port);
      });
    });
  } finally {
    socket.close();
  }
}

function isLinkedWorktree(): boolean {
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  return gitDir !== commonDir;
}

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

const onboarding = parseOnboardingOverride(process.argv.slice(2));

await run(["bun", "run", "dev:proxy"]);
const serverPort = process.env.SERVER_PORT ?? String(await availableHttpPort());
const linkedWorktree = isLinkedWorktree();
const udpPort = linkedWorktree ? String(await availableUdpPort()) : undefined;
// Portless prefixes branch names, but different worktrees can share a branch name
// (or be detached). Add a stable path identity to keep their routes distinct.
const worktreeId = linkedWorktree
  ? createHash("sha256").update(realpathSync(process.cwd())).digest("hex").slice(0, 16)
  : undefined;
const portlessName = worktreeId ? `raceiq-${worktreeId}` : "raceiq";
const environment = {
  ...process.env,
  SERVER_PORT: serverPort,
  RACEIQ_DEV_PORTLESS_NAME: portlessName,
  ...(udpPort ? { RACEIQ_DEV_UDP_PORT: udpPort } : {}),
};
console.log(`[Dev] Portless name: ${portlessName}; backend HTTP: ${serverPort}${udpPort ? `; worktree UDP: ${udpPort}` : ""}`);

const serverCommand = ["bun", "--env-file=.env.development", "--watch", "run", "server/index.ts"];
if (onboarding !== null) {
  serverCommand.push("--onboarding", String(onboarding));
}

const developmentProcesses = Bun.spawn(
  [
    "bunx",
    "concurrently",
    serverCommand.join(" "),
    "bun scripts/dev/client.ts",
  ],
  {
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await developmentProcesses.exited);
