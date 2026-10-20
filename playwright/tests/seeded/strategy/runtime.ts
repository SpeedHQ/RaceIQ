import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected allocated TCP port");
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

/** Subprocess controls stay in the runner; the production app gains no test endpoints. */
export class StrategyRuntime {
  private backend: ChildProcess | null = null;
  private frontend: ChildProcess | null = null;
  private readonly logs: string[] = [];
  private constructor(readonly root: string, readonly dataDir: string, readonly backendPort: number, readonly clientPort: number, readonly udpPort: number) {}
  get baseURL(): string { return `http://127.0.0.1:${this.clientPort}`; }
  get apiURL(): string { return `http://127.0.0.1:${this.backendPort}`; }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, DATA_DIR: this.dataDir, SERVER_PORT: String(this.backendPort), UDP_PORT: String(this.udpPort), NODE_ENV: "test", RACEIQ_E2E: "1", PW_ACCESS_MODE: "disabled", RACEIQ_SETUP_HOME: resolve(this.dataDir, "setup-home") };
  }
  private launch(args: string[], cwd = this.root, env = this.env()): ChildProcess {
    const child = spawn("bun", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => this.logs.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.logs.push(chunk.toString()));
    child.on("error", (error) => this.logs.push(String(error)));
    return child;
  }
  private async waitReady(url: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Runtime exited before ready: ${this.logs.slice(-12).join("")}`);
      try { if ((await fetch(url)).ok) return; } catch { /* Startup has not bound its listener yet. */ }
      await delay(200);
    }
    throw new Error(`Runtime readiness timed out: ${url}\n${this.logs.slice(-12).join("")}`);
  }
  private async stopChild(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  static async start(dataDir: string, withFrontend = true): Promise<StrategyRuntime> {
    const root = resolve(__dirname, "../../../..");
    const runtime = new StrategyRuntime(root, dataDir, await availablePort(), await availablePort(), await availablePort());
    await mkdir(dataDir, { recursive: true });
    await writeFile(resolve(dataDir, "settings.json"), JSON.stringify({ onboardingComplete: true, udpPort: runtime.udpPort }));
    const initialize = runtime.launch(["playwright/support/server/initialize-access.ts"]);
    const code = await new Promise<number | null>((accept) => initialize.once("exit", accept));
    if (code !== 0) throw new Error(`Access initialization failed: ${runtime.logs.join("")}`);
    try {
      await runtime.startBackend();
      if (withFrontend) {
        runtime.frontend = runtime.launch(["run", "dev", "--", "--host", "127.0.0.1", "--port", String(runtime.clientPort), "--strictPort"], resolve(root, "client"), { ...runtime.env(), PROXY_TARGET: runtime.apiURL });
        await runtime.waitReady(runtime.baseURL, runtime.frontend);
      }
      return runtime;
    } catch (error) { await runtime.stop(); throw error; }
  }
  private async startBackend(): Promise<void> {
    this.backend = this.launch(["run", "apps/backend/src/index.ts"]);
    await this.waitReady(`${this.apiURL}/api/status`, this.backend);
  }
  async restart(): Promise<void> { await this.stopChild(this.backend); this.backend = null; await this.startBackend(); }
  async crash(): Promise<void> {
    const backend = this.backend;
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) throw new Error("Expected a running backend to crash");
    await new Promise<void>((accept) => { backend.once("exit", () => accept()); backend.kill("SIGKILL"); });
    this.backend = null;
  }
  /** Fault injection touches only this runner-owned disposable database. */
  async setPersistenceFailure(enabled: boolean, table: "strategy_lap_metrics" | "strategy_source_admissions" | "laps" = "strategy_lap_metrics"): Promise<void> {
    const sql = enabled
      ? `CREATE TRIGGER strategy_e2e_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'strategy E2E injected storage failure'); END`
      : "DROP TRIGGER IF EXISTS strategy_e2e_fail";
    const child = this.launch(["-e", 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); db.run(process.argv[2]); db.close();', resolve(this.dataDir, "app.db"), sql]);
    const code = await new Promise<number | null>((accept) => child.once("exit", accept));
    if (code !== 0) throw new Error(`Failed to configure persistence fault: ${this.logs.slice(-12).join("")}`);
  }
  async stop(): Promise<void> {
    await Promise.all([this.stopChild(this.backend), this.stopChild(this.frontend)]);
    this.backend = null;
    this.frontend = null;
    await writeFile(resolve(this.dataDir, "runtime.log"), this.logs.join(""));
  }
}
