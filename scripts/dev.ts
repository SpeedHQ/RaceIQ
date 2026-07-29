import { parseOnboardingOverride } from "../server/runtime-options";

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

const serverCommand = ["bun", "--watch", "run", "server/index.ts"];
if (onboarding !== null) {
  serverCommand.push("--onboarding", String(onboarding));
}

const developmentProcesses = Bun.spawn(
  [
    "bunx",
    "concurrently",
    serverCommand.join(" "),
    "cd client && portless raceiq bun run dev",
  ],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await developmentProcesses.exited);
