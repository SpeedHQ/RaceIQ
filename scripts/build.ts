import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const root = process.cwd();
const distDir = join(root, "dist");

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}`);
  }
}

async function main() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  await run(["bun", "run", "build"], { cwd: join(root, "client") });
  await run(["bun", "scripts/copy-shared-data.ts"]);
  await run(["bun", "scripts/copy-client-dist.ts"]);

  const compileArgs = [
    "bun",
    "build",
    "--compile",
    "--define",
    'process.env.NODE_ENV="production"',
  ];

  if (process.platform === "win32") {
    const iconPath = join(root, "assets", "raceiq.ico");
    if (existsSync(iconPath)) {
      compileArgs.push(`--windows-icon=${iconPath}`);
    }
    compileArgs.push(
      "--windows-title=RaceIQ",
      "--windows-publisher=SpeedHQ",
      '--windows-description=RaceIQ',
    );
  }

  compileArgs.push("server/bootstrap.ts", "--outfile", join(distDir, "raceiq"));

  await run(compileArgs, { env: { NODE_ENV: "production" } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
