import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The first RaceIQ desktop target is macOS");
const root = fileURLToPath(new URL("../..", import.meta.url));
for (const command of [["bun", "run", "build:browser"], ["bun", "run", "--cwd", "apps/desktop", "native:build"]]) {
  const child = Bun.spawn(command, { cwd: root, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
