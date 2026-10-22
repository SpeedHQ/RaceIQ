import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export interface SourceUpgradeHarness {
  readonly workspace: string;
  readonly checkoutDir: string;
  readonly dataDir: string;
  readonly baseURL: string;
  readonly apiURL: string;
  readonly previousTag: string;
  readonly previousSha: string;
  readonly mainSha: string;
  checkoutPrevious(): Promise<void>;
  seedPrevious(): Promise<void>;
  validateConvertedCaptures(): Promise<void>;
  checkoutMain(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  logs(): string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_MEMORY_LOG = 64 * 1024;
const COMMAND_TIMEOUT = 120_000;
const START_TIMEOUT = 60_000;

export async function createSourceUpgradeHarness(): Promise<SourceUpgradeHarness> {
  const callerRoot = process.env.RACEIQ_APP_ROOT ? resolve(process.env.RACEIQ_APP_ROOT) : repoRoot;
  const artifactsDir = resolve(process.env.RACEIQ_UPGRADE_ARTIFACTS_DIR ?? join(callerRoot, "playwright/test-results/source-upgrade"));
  mkdirSync(artifactsDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(artifactsDir, `source-upgrade-${runId}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const writeLog = (text: string) => logStream.write(`${new Date().toISOString()} ${text}\n`);
  const tempRoot = await mkdtemp(join(tmpdir(), "raceiq-source-upgrade-"));
  const workspace = tempRoot;
  const checkoutDir = join(tempRoot, "source");
  const dataDir = join(tempRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const memory: string[] = [];
  let memorySize = 0;
  const processes = new Set<ChildProcess>();
  let phase: "created" | "previous" | "seeded" | "main" | "running" | "disposed" = "created";
  let runningFrom: "seeded" | "main" | undefined;
  let previousTag = "";
  let previousSha = "";
  let mainSha = "";
  const generatedHashes = new Set<string>();
  let childError = "";
  const record = (text: string) => {
    writeLog(text);
    process.stdout.write(`[upgrade] ${text}\n`);
    const line = `${text}\n`;
    memory.push(line);
    memorySize += line.length;
    while (memorySize > MAX_MEMORY_LOG && memory.length > 1) memorySize -= memory.shift()!.length;
  };
  const bun = process.env.BUN_EXECUTABLE ?? "bun";
  const git = async (args: string[], cwd = callerRoot) => run("git", args, cwd);
  const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, timeout = COMMAND_TIMEOUT) => new Promise<string>((resolvePromise, reject) => {
    record(`$ ${command} ${args.map((arg) => JSON.stringify(arg)).join(" ")} (cwd=${cwd})`);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    processes.add(child);
    let output = "";
    let timedOut = false;
    const outputLimit = 64 * 1024;
    const capture = (chunk: Buffer) => {
      const value = chunk.toString();
      output += value;
      if (output.length > outputLimit) output = output.slice(-outputLimit);
      record(value.trimEnd());
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { child.kill(signal); }
      } else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; killTree("SIGTERM"); }, timeout);
    child.once("error", (error) => { clearTimeout(timer); processes.delete(child); reject(new Error(`${command} could not start: ${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      processes.delete(child);
      if (timedOut) reject(new Error(`${command} ${args.join(" ")} timed out after ${timeout}ms. See ${logPath}`));
      else if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}). See ${logPath}`));
    });
  });
  const allocatePort = () => new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Unable to allocate loopback port")); return; }
      server.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
  const allocateUdpPort = () => new Promise<number>((resolvePromise, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolvePromise(address.port));
    });
  });
  const [serverPort, uiPort, udpPort] = await Promise.all([allocatePort(), allocatePort(), allocateUdpPort()]);
  const readRefs = async (tag: string) => {
    if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
    previousTag = tag;
    previousSha = (await git(["rev-parse", "--verify", `${tag}^{commit}`], checkoutDir)).trim();
    mainSha = (await git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], checkoutDir)).trim();
    if (!/^[A-Fa-f0-9]{40}$/.test(previousSha) || !/^[A-Fa-f0-9]{40}$/.test(mainSha)) throw new Error(`Invalid resolved refs: previous=${previousSha}, main=${mainSha}`);
    writeFileSync(join(artifactsDir, `source-upgrade-${runId}.json`), JSON.stringify({ callerRoot, workspace, checkoutDir, dataDir, previousTag, previousSha, mainSha, logPath }, null, 2));
    record(`refs previous=${previousTag} ${previousSha} main=origin/main ${mainSha}`);
  };
  const terminateChildren = async () => {
    const children = [...processes];
    const liveChildren = children.filter((child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null);
    for (const child of children) {
      if (!child.pid) continue;
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch { child.kill("SIGTERM"); }
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      }
    }
    const closeEvents = liveChildren.map((child) => new Promise<void>((done) => child.once("close", () => done())));
    await Promise.race([Promise.all(closeEvents), delay(5_000)]);
    if (process.platform !== "win32") {
      for (const child of children) {
        if (!child.pid) continue;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    } else {
      for (const child of children) if (child.pid) {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch { /* Already gone or taskkill timed out. */ }
      }
    }
    await Promise.race([Promise.all(closeEvents), delay(3_000)]);
    const stillLive = liveChildren.filter((child) => child.exitCode === null && child.signalCode === null);
    if (stillLive.length) throw new Error(`Could not stop owned processes: ${stillLive.map((child) => child.pid ?? "spawn-error").join(", ")}. See ${logPath}`);
    const ownedGroups = process.platform === "win32" ? [] : children.flatMap((child) => child.pid ? [child.pid] : []);
    const groupIsAlive = (pid: number) => {
      try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const groupDeadline = Date.now() + 2_000;
    while (ownedGroups.some(groupIsAlive) && Date.now() < groupDeadline) await delay(100);
    const lingeringGroups = ownedGroups.filter(groupIsAlive);
    if (lingeringGroups.length) throw new Error(`Owned process groups remain after SIGKILL: ${lingeringGroups.join(", ")}. See ${logPath}`);
    processes.clear();
  };
  const apiURL = () => `http://127.0.0.1:${serverPort}`;
  const baseURL = () => `http://127.0.0.1:${uiPort}`;
  const waitReady = async (url: string, label: string, child: ChildProcess, expectedStatus: number, headers?: Record<string, string>) => {
    const deadline = Date.now() + START_TIMEOUT;
    while (Date.now() < deadline) {
      if (childError) throw new Error(`${label} failed to spawn: ${childError}. See ${logPath}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before readiness. See ${logPath}`);
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
        if (response.status === expectedStatus) return;
      } catch { /* Retry within the bounded startup deadline. */ }
      await delay(250);
    }
    throw new Error(`${label} did not become ready at ${url}. See ${logPath}`);
  };
  const harness: SourceUpgradeHarness = {
    workspace, checkoutDir, dataDir, get baseURL() { return baseURL(); }, get apiURL() { return apiURL(); },
    get previousTag() { return previousTag; }, get previousSha() { return previousSha; }, get mainSha() { return mainSha; },
    async validateConvertedCaptures() {
      if (phase !== "seeded") throw new Error(`validateConvertedCaptures invalid in phase ${phase}`);
      const script = `
        import Database from "libsql";
        import { iterateSessionCaptureRecordsFromSource } from "./server/session-capture/source-loader.ts";
        import { existsSync } from "node:fs";
        import { resolve } from "node:path";
        import { DecompressionStream } from "node:stream/web";
        // Resolve capture modules from the checked-out release's pre/post-package layout.
        const captureModules = existsSync("./server/session-capture/framing.ts") ? "./server/session-capture/" : "./packages/capture-formats/src/session/";
        const { META_FRAME_MAGIC, readFramePrefix } = await import(captureModules + "framing");
        const { isLmuSparseFrame } = await import(captureModules + "lmu-sparse");
        const { isKunosSparseFrame } = await import(captureModules + "kunos-sparse");
        const { isGenericSparseFrame } = await import(captureModules + "generic-sparse");
        const database = new Database(resolve(process.env.DATA_DIR!, "app.db"), { readonly: true });
        try {
          const rows = database.prepare("SELECT * FROM sessions ORDER BY game_id, id").all();
          if (!rows.length) throw new Error("No sessions found at conversion boundary");
          let failures = 0;
          for (const row of rows) {
            const file = String(row.raw_file ?? "");
            const label = \`game=\${row.game_id} session=\${row.id} file=\${file || "(missing)"}\`;
            try {
              if (!file || Number(row.capture_format_version) !== 1) throw new Error(\`missing converted provenance (captureFormatVersion=\${row.capture_format_version ?? "null"})\`);
              if (!existsSync(file)) throw new Error("recording file missing");
              const blob = Bun.file(file);
              const zipPrefix = Buffer.from(await blob.slice(0, 2).arrayBuffer());
              let stream = blob.stream();
              if (zipPrefix[0] === 0x1f && zipPrefix[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream("gzip"));
              const reader = stream.getReader();
              let pending = Buffer.alloc(0), initialized = false, marker = false, delta = false, checkpoints = 0;
              try {
                while (true) {
                  const next = await reader.read();
                  if (next.done) break;
                  pending = pending.length ? Buffer.concat([pending, next.value]) : Buffer.from(next.value);
                  if (!initialized) {
                    if (pending.length < 8) continue;
                    if (pending.readUInt32LE(0) === META_FRAME_MAGIC) {
                      const length = pending.readUInt32LE(4);
                      if (length > 16 * 1024 * 1024) throw new Error("oversized capture metadata");
                      if (pending.length < 8 + length) continue;
                      pending = pending.subarray(8 + length);
                    }
                    initialized = true;
                  }
                  while (pending.length >= 4) {
                    if (pending.readUInt32LE(0) === META_FRAME_MAGIC) {
                      if (pending.length < 8) break;
                      const length = pending.readUInt32LE(4);
                      if (length > 16 * 1024 * 1024) throw new Error("oversized capture metadata");
                      if (pending.length < 8 + length) break;
                      // v0.19.2 predates named sparse marker exports; use its persisted wire values.
                      if (length === 8 && pending.readUInt32LE(8) === 0x31505352 && pending.readUInt32LE(12) === 1) marker = true;
                      pending = pending.subarray(8 + length);
                      continue;
                    }
                    const length = pending.readUInt32LE(0) & 0x7fffffff;
                    if (length <= 0 || length > 16 * 1024 * 1024) throw new Error("invalid capture record length");
                    const prefix = readFramePrefix(pending, 0);
                    if (!prefix) {
                      if (pending.length >= 12) throw new Error("invalid capture frame prefix");
                      break;
                    }
                    if (pending.length < prefix.prefixBytes + prefix.length) break;
                    const frame = pending.subarray(prefix.prefixBytes, prefix.prefixBytes + prefix.length);
                    if (isLmuSparseFrame(frame) || isKunosSparseFrame(frame) || isGenericSparseFrame(frame)) delta = true;
                    else checkpoints++;
                    pending = pending.subarray(prefix.prefixBytes + prefix.length);
                  }
                }
                if (!initialized || pending.length) throw new Error("truncated capture record");
              } finally {
                await reader.cancel();
                reader.releaseLock();
              }
              let frames = 0;
              const source = { rawFile: file, source: row.source == null ? null : String(row.source), gameId: String(row.game_id), captureFormatVersion: Number(row.capture_format_version), carOrdinal: Number(row.car_ordinal ?? -1), trackOrdinal: Number(row.track_ordinal ?? -1), carId: String(row.car_id ?? ""), trackId: String(row.track_id ?? "") };
              for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) if (record.kind === "frame") frames++;
              if (!frames) throw new Error("capture contains no decodable frames");
              const classification = marker ? (delta ? "marker+delta" : "marker+checkpoint-only") : (delta ? "delta-without-marker" : checkpoints ? "checkpoint-only" : "no-frame-data");
              console.log(\`[upgrade-boundary] \${label} captureFormatVersion=1 \${classification} frames=\${frames}\`);
            } catch (error) { failures++; console.error(\`[upgrade-boundary] FAIL \${label}: \${error instanceof Error ? error.message : String(error)}\`); }
          }
          if (failures) throw new Error(\`\${failures}/\${rows.length} converted recording boundary checks failed\`);
        } finally {
          database.close();
        }
      `;
      await run(bun, ["-e", script], checkoutDir, { ...process.env, DATA_DIR: dataDir, APPDATA: dataDir, RACEIQ_APP_ROOT: checkoutDir });
    },
    async checkoutPrevious() {
      if (phase !== "created") throw new Error(`checkoutPrevious invalid in phase ${phase}`);
      const configuredSource = process.env.RACEIQ_UPGRADE_REPOSITORY;
      let origin = configuredSource ?? (await git(["remote", "get-url", "origin"])).trim();
      if (!origin) throw new Error("No source repository URL: set RACEIQ_UPGRADE_REPOSITORY or configure caller origin");
      if (configuredSource && /^[^/]+\/[^/]+$/.test(configuredSource)) origin = `https://github.com/${configuredSource}.git`;
      const releaseRepository = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? origin
        .replace(/^git@github\.com:/, "")
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\.git$/, "");
      if (!releaseRepository || releaseRepository === origin) throw new Error("Cannot determine GitHub release repository; set GH_REPO or GITHUB_REPOSITORY");
      const tag = process.env.RACEIQ_UPGRADE_PREVIOUS_TAG;
      if (tag && !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
      if (tag) {
        await run("git", ["clone", "--filter=blob:none", "--no-checkout", "--", origin, checkoutDir], callerRoot);
        await git(["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`, "+refs/heads/main:refs/remotes/origin/main"], checkoutDir);
      } else {
        const release = await run("gh", ["release", "view", "--repo", releaseRepository, "--json", "tagName", "-q", ".tagName"], callerRoot);
        previousTag = release.trim();
        if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(previousTag)) throw new Error(`Invalid release tag: ${previousTag}`);
        await run("git", ["clone", "--filter=blob:none", "--no-checkout", "--", origin, checkoutDir], callerRoot);
        await git(["fetch", "--no-tags", "origin", `refs/tags/${previousTag}:refs/tags/${previousTag}`, "+refs/heads/main:refs/remotes/origin/main"], checkoutDir);
      }
      await readRefs(previousTag || tag!);
      await git(["checkout", "--detach", previousSha], checkoutDir);
      phase = "previous";
    },
    async seedPrevious() {
      if (phase !== "previous") throw new Error(`seedPrevious invalid in phase ${phase}`);
      await run(bun, ["install", "--frozen-lockfile"], checkoutDir);
      const seedEnv: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, APPDATA: dataDir, RACEIQ_APP_ROOT: checkoutDir };
      delete seedEnv.RACEIQ_E2E;
      await run(bun, ["run", "db:seed"], checkoutDir, seedEnv, 10 * 60_000);
      record(`seeded all released game fixtures into data=${dataDir}`);
      phase = "seeded";
    },
    async checkoutMain() {
      if (phase !== "seeded") throw new Error(`checkoutMain invalid in phase ${phase}`);
      if (processes.size) throw new Error("Cannot switch refs while child processes are running");
      await git(["checkout", "--detach", mainSha], checkoutDir);
      await run(bun, ["install", "--frozen-lockfile"], checkoutDir);
      phase = "main";
    },
    async start() {
      if (phase !== "seeded" && phase !== "main") throw new Error(`start invalid in phase ${phase}`);
      const refSha = phase === "seeded" ? previousSha : mainSha;
      if (!generatedHashes.has(refSha)) {
        const generator = join(checkoutDir, "scripts/dev/paraglide-dev.ts");
        if (!existsSync(generator)) throw new Error(`Source checkout lacks supported Paraglide generator: ${generator}`);
        await run(bun, [generator, "--once"], checkoutDir);
        generatedHashes.add(refSha);
      }
      const runtimeEnv: NodeJS.ProcessEnv = { ...process.env };
      delete runtimeEnv.RACEIQ_E2E;
      runtimeEnv.RACEIQ_APP_ROOT = checkoutDir;
      const commonEnv = { ...runtimeEnv, DATA_DIR: dataDir, APPDATA: dataDir, SERVER_PORT: String(serverPort), UDP_PORT: String(udpPort) };
      const backend = spawn(bun, ["run", "apps/backend/src/index.ts"], { cwd: checkoutDir, env: commonEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      processes.add(backend);
      for (const stream of [backend.stdout, backend.stderr]) stream?.on("data", (chunk: Buffer) => record(`[backend] ${chunk.toString().trimEnd()}`));
      backend.once("error", (error) => { childError = error.message; });
      if (phase === "seeded") await waitReady(`${apiURL()}/api/cars`, "previous backend", backend, 200, { "X-Game-Id": "ac-evo" });
      else await waitReady(`${apiURL()}/api/auth/status`, "main backend", backend, 200);
      const client = spawn(bun, ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"], { cwd: join(checkoutDir, "client"), env: { ...commonEnv, SERVER_PORT: String(serverPort), PROXY_TARGET: apiURL(), PORT: String(uiPort) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      processes.add(client);
      for (const stream of [client.stdout, client.stderr]) stream?.on("data", (chunk: Buffer) => record(`[client] ${chunk.toString().trimEnd()}`));
      client.once("error", (error) => { childError = error.message; });
      await waitReady(baseURL(), "Vite client", client, 200);
      runningFrom = phase;
      phase = "running";
      record(`ready api=${apiURL()} ui=${baseURL()} data=${dataDir}`);
    },
    async stop() {
      await terminateChildren();
      if (phase === "running") phase = runningFrom ?? "main";
      runningFrom = undefined;
      record("stopped owned processes");
    },
    async dispose() {
      if (phase === "disposed") return;
      try {
        await terminateChildren();
      } finally {
        phase = "disposed";
        record(`disposed; preserved workspace=${tempRoot}`);
        await new Promise<void>((resolvePromise, reject) => {
          logStream.once("error", reject);
          logStream.end(resolvePromise);
        });
      }
    },
    logs() { return memory.join(""); },
  };
  record(`created workspace=${workspace} checkout=${checkoutDir} artifacts=${artifactsDir} log=${logPath}`);
  return harness;
}
