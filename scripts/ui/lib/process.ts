import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  quiet?: boolean;
}

export async function run(command: string[], options: RunOptions): Promise<string> {
  if (!options.quiet) console.log(`\n> ${command.join(" ")}`);
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });
  const exitCode = await proc.exited;
  const stdout = options.quiet ? await new Response(proc.stdout).text() : "";
  const stderr = options.quiet ? await new Response(proc.stderr).text() : "";
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `Command failed (${exitCode}): ${command.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
  }
  return stdout.trimEnd();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function requireNode(repoRoot: string): Promise<string> {
  const missingNode = () =>
    new Error(
      "Node.js is required for `bun run ui:diff`. Install Node.js, then rerun. " +
        "The Playwright runner cannot use Bun's Node compatibility layer on Windows.",
    );
  const nodePath = [
    Bun.which("node"),
    process.platform === "win32"
      ? "C:\\Program Files\\nodejs\\node.exe"
      : undefined,
  ].find(
    (candidate): candidate is string =>
      Boolean(
        candidate &&
          !candidate.includes("bun-node-") &&
          existsSync(candidate),
      ),
  );
  if (!nodePath) throw missingNode();

  let version: string;
  try {
    version = await run([nodePath, "--version"], {
      cwd: repoRoot,
      quiet: true,
    });
  } catch {
    throw missingNode();
  }
  console.log(`Using Node.js ${version}`);
  return nodePath;
}

export function requirePlaywrightCli(
  repoRoot: string,
  workspace: "client" | "playwright",
): string {
  const candidates = [
    join(repoRoot, workspace, "node_modules", "@playwright", "test", "cli.js"),
    join(repoRoot, "node_modules", "@playwright", "test", "cli.js"),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) {
    throw new Error(
      `Playwright CLI is missing for ${workspace}; run bun install before UI comparison`,
    );
  }
  return cli;
}

export async function removeRuntimeData(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }
  console.warn(`Could not remove UI-diff runtime data ${path}: ${errorMessage(lastError)}`);
}

export async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Could not reserve a local comparison port"));
          return;
        }
        const selected = address.port;
        server.close((error) => (error ? reject(error) : resolvePort(selected)));
      });
    });
    ports.push(port);
  }
  return ports;
}

export function openReport(reportPath: string, cwd: string): void {
  const command =
    process.platform === "win32"
      ? ["cmd.exe", "/c", "start", "", reportPath]
      : process.platform === "darwin"
        ? ["open", reportPath]
        : ["xdg-open", reportPath];
  Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
}
