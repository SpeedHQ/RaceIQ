import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../../../../..");

export function upgradeEnvironment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, NODE_ENV: "production", SERVER_HOST: "127.0.0.1" };
  delete env.RACEIQ_TEST_MODE;
  delete env.DB_IN_MEMORY;
  delete env.RACEIQ_TEST_DATA_DIR;
  delete env.PW_SEED_SCREENSHOTS;
  delete env.SERVER_PASSWORD;
  delete env.SERVER_ALLOWED_ORIGINS;
  delete env.RACEIQ_CLASSIFICATION_TEST_BARRIER;
  delete env.RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR;
  return env;
}

export async function command(args: string[], cwd = ROOT, env = process.env) {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return stdout;
}

export interface UpgradeServer {
  readonly output: string;
  address(): Promise<string>;
  ready(): Promise<void>;
  udpReady(): Promise<void>;
  stop(): Promise<void>;
}

/** Starts the production boot path against an isolated upgrade database. */
export function startUpgradeServer(dataDir: string, extraEnv: NodeJS.ProcessEnv = {}): UpgradeServer {
  const proc = Bun.spawn([process.execPath, "--eval", `
    import { captureConsole } from "./server/runtime/logger";
    import { bootServer } from "./apps/backend/src/runtime/boot";
    captureConsole();
    const server = await bootServer({ httpPort: Number(process.env.RACEIQ_UPGRADE_HTTP_PORT ?? 0), udpPort: Number(process.env.RACEIQ_UPGRADE_UDP_PORT ?? 0), recordingGameId: null });
    console.log("UPGRADE_HTTP_ADDRESS=" + server.httpServer.url.origin);
  `], { cwd: ROOT, env: { ...upgradeEnvironment(dataDir), ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  let output = "";
  let exited = false;
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([consume(proc.stdout), consume(proc.stderr)]);
  void proc.exited.then(() => { exited = true; });
  const waitFor = async (predicate: () => boolean, description: string) => {
    const deadline = Date.now() + 180_000;
    while (!predicate()) {
      if (exited || Date.now() >= deadline) throw new Error(`${description} failed:\n${output}`);
      await Bun.sleep(20);
    }
  };
  return {
    get output() { return output; },
    async address() {
      await waitFor(() => /UPGRADE_HTTP_ADDRESS=(https?:\/\/[^\s]+)/.test(output), "HTTP startup");
      return /UPGRADE_HTTP_ADDRESS=(https?:\/\/[^\s]+)/.exec(output)![1]!;
    },
    async ready() {
      await waitFor(() => output.includes("[SessionRepair] Historical session reconciliation complete:"), "Historical reconciliation");
      if (output.includes("reconciliation failed:")) throw new Error(output);
    },
    async udpReady() {
      await waitFor(() => output.includes("[UDP] Listening on"), "UDP startup");
    },
    async stop() {
      if (!exited) proc.kill("SIGKILL");
      await proc.exited;
      await drained;
    },
  };
}
