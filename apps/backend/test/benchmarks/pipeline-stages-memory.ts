import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type MemoryEngine = "bun" | "rust";
export const MEMORY_TRIALS = 3;
export const MEMORY_LIMITATIONS = "Headline memory is median end-of-stage retained growth with stage state alive and transient returned outputs released, excluding loaded fixtures and prepared inputs. Bun uses post-GC JSC-accounted heap/backing storage; Rust uses live requested Rust allocation bytes. Accounting and processing scopes still differ. Diagnostic peakAdditionalBytes means sampled post-GC maximum for Bun, true requested-allocation peak for Rust: these are not equivalent transient peaks. Bun misses temporary allocations between samples; GC/runtime/JIT effects remain. Allocator overhead and untracked native/direct C allocations are excluded; allocation churn is not measured. Profile timing discarded.";
const PROFILE_TIMEOUT_MS = 180_000;
export type StageMemory = { samples: { peakAdditionalBytes: number; retainedAdditionalBytes: number }[]; peakAdditionalBytes: number; retainedAdditionalBytes: number };
export type MemoryProfile = { method: "stage-code-memory-v4"; metric: "bun-post-gc-live-heap-bytes" | "rust-requested-live-allocation-bytes"; pid: number; hostPid: number; nativeProfile: string | null; nativeExecutable: string | null; parse: StageMemory; pipeline: StageMemory; profileTrials: number; exclusions: string; limitations: string };
export type PipelineStage = { samplesSeconds: number[]; medianSeconds: number; acceptedPackets?: number; processedPackets?: number; nsPerFrame: number | null; nsPerPacket: number | null };
export type PipelineGame = { gameId: string; fixture: string; sourceHash: string; workloadHash: string; sourceFrames: number; records: number; contextRecords: number; segmentRecords: number; engines: Partial<Record<MemoryEngine, { parse: PipelineStage; pipeline: PipelineStage; memory?: MemoryProfile | { error: string } }>>; crossEngineCountMismatch?: boolean };
const stageMemorySchema = z.object({ samples: z.array(z.object({ peakAdditionalBytes: z.number().int().nonnegative(), retainedAdditionalBytes: z.number().int().nonnegative() })).length(MEMORY_TRIALS), peakAdditionalBytes: z.number().int().nonnegative(), retainedAdditionalBytes: z.number().int().nonnegative() });
const stageSchema = z.object({ samplesSeconds: z.array(z.number().positive().finite()).length(MEMORY_TRIALS), acceptedPackets: z.number().int().positive().optional(), processedPackets: z.number().int().positive().optional() });
const childReportSchema = z.object({ config: z.object({ engine: z.enum(["bun", "rust"]), game: z.string(), frames: z.number().int().positive(), trials: z.literal(MEMORY_TRIALS), memory: z.literal("off") }), runtime: z.object({ pid: z.number().int().positive(), nativePid: z.number().int().positive().nullable(), nativeProfile: z.string().nullable(), nativeExecutable: z.string().nullable() }), errors: z.array(z.unknown()).length(0), games: z.array(z.object({ gameId: z.string(), sourceHash: z.string(), workloadHash: z.string(), sourceFrames: z.number().int().positive(), records: z.number().int().positive(), contextRecords: z.number().int().nonnegative(), segmentRecords: z.number().int().nonnegative(), engines: z.record(z.string(), z.object({ parse: stageSchema, pipeline: stageSchema, memory: z.object({ metric: z.enum(["bun-post-gc-live-heap-bytes", "rust-requested-live-allocation-bytes"]), parse: stageMemorySchema, pipeline: stageMemorySchema }).optional() })) })).length(1) });
async function psParent(pid: number): Promise<number> {
 const { promise, resolve, reject } = Promise.withResolvers<number>();
 const ps = spawn("ps", ["-o", "ppid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
 let text = "";
 const timer = setTimeout(() => { ps.kill("SIGKILL"); reject(Error(`ps ppid timed out for PID ${pid}`)); }, 5000);
 ps.stdout!.on("data", (bytes) => { text += bytes.toString(); });
 ps.once("error", (error) => { clearTimeout(timer); reject(error); });
 ps.once("close", (code) => {
  clearTimeout(timer);
  const parent = Number(text.trim());
  if (code !== 0 || !Number.isSafeInteger(parent)) reject(Error(`Cannot validate native child PID ${pid}`));
  else resolve(parent);
 });
 return promise;
}
export async function profileEngineMemory(request: { runner: string; engine: MemoryEngine; frames: number; game: PipelineGame }): Promise<MemoryProfile> {
 const directory = mkdtempSync(join(tmpdir(), "raceiq-pipeline-memory-")); const output = join(directory, "report.json"); let child: ChildProcess | undefined, diagnostics = "", exited = false, nativePid: number | undefined, nativeExecutable: string | undefined, succeeded = false, deadline: NodeJS.Timeout | undefined, onNativeStarted: ((message: unknown) => void) | undefined;
 try {
  const args = [request.runner, `--engine=${request.engine}`, `--game=${request.game.gameId}`, `--frames=${request.frames}`, `--trials=${MEMORY_TRIALS}`, "--memory=off", `--output=${output}`];
  child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, RACEIQ_PIPELINE_MEMORY_CHILD: "1", RACEIQ_PIPELINE_MEMORY_TEMP_DIR: directory } });
  child.stdout!.on("data", (b) => { diagnostics = (diagnostics + b.toString()).slice(-32768); }); child.stderr!.on("data", (b) => { diagnostics = (diagnostics + b.toString()).slice(-32768); });
  const { promise: failTimer, reject: rejectDeadline } = Promise.withResolvers<never>();
  deadline = setTimeout(() => rejectDeadline(Error(`Memory profile timed out after ${PROFILE_TIMEOUT_MS} ms`)), PROFILE_TIMEOUT_MS);
  const { promise: closed, resolve: resolveClosed, reject: rejectClosed } = Promise.withResolvers<void>();
  child.once("error", rejectClosed);
  child.once("close", (code, signal) => { exited = true; if (code === 0) resolveClosed(); else rejectClosed(Error(`Memory child exited (${code ?? signal})`)); });
  const { promise: handshake, resolve: resolveHandshake, reject: rejectHandshake } = Promise.withResolvers<void>();

  if (request.engine === "rust") {
   onNativeStarted = async (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "pipeline-memory-native-started") return;
    child!.off("message", onNativeStarted!); onNativeStarted = undefined;
    if (!("pid" in message) || !("executable" in message)) { rejectHandshake(Error("Invalid native startup identity")); return; }
    const pid = message.pid, executable = message.executable;
    try {
     if (typeof pid !== "number" || !Number.isSafeInteger(pid) || typeof executable !== "string" || !executable) throw Error("Invalid native startup identity");
     if (!child!.pid || await psParent(pid) !== child!.pid) throw Error("Memory native process is not owned by Bun child");
     nativePid = pid; nativeExecutable = executable;
     child!.send({ type: "pipeline-memory-native-continue" }, (error) => error ? rejectHandshake(error) : resolveHandshake());
    } catch (error) { rejectHandshake(error); }
   };
   child.on("message", onNativeStarted);
   closed.then(() => { if (nativePid === undefined) rejectHandshake(Error("Memory child exited before native startup")); }, rejectHandshake);
  } else resolveHandshake();
  await Promise.race([Promise.all([closed, handshake]), failTimer]);
  if (onNativeStarted) { child.off("message", onNativeStarted); onNativeStarted = undefined; }
  // The child has exited only after both startup handshake and workload completion.
  const parsed = childReportSchema.safeParse(JSON.parse(readFileSync(output, "utf8"))); if (!parsed.success) throw Error(`Memory child report validation failed: ${parsed.error.message}`);
  const report = parsed.data, game = report.games[0]!;
  if (report.config.engine !== request.engine || report.config.game !== request.game.gameId || report.config.frames !== request.frames) throw Error("Memory child report configuration differs from request");
  for (const key of ["gameId", "sourceHash", "workloadHash", "sourceFrames", "records", "contextRecords", "segmentRecords"] as const) if (game[key] !== request.game[key]) throw Error(`Memory child ${key} differs from throughput workload`);
  if (Object.keys(game.engines).length !== 1 || !game.engines[request.engine]) throw Error("Memory child did not run exactly requested engine");
  const result = game.engines[request.engine]!, expected = request.game.engines[request.engine]!;
  if (result.parse.acceptedPackets !== expected.parse.acceptedPackets || result.pipeline.processedPackets !== expected.pipeline.processedPackets || result.pipeline.processedPackets !== result.parse.acceptedPackets) throw Error("Memory child packet count validation failed");
  const metrics = result.memory; if (!metrics) throw Error("Memory child omitted code-memory measurements");
  const metric = request.engine === "bun" ? "bun-post-gc-live-heap-bytes" : "rust-requested-live-allocation-bytes"; if (metrics.metric !== metric) throw Error("Memory metric mismatch");
  if (report.runtime.pid !== child.pid || (request.engine === "rust" && (nativePid === undefined || report.runtime.nativePid !== nativePid || report.runtime.nativeExecutable !== nativeExecutable || report.runtime.nativeProfile !== "release"))) throw Error("Memory child runtime/native validation failed");
  succeeded = true;
  return { method: "stage-code-memory-v4", metric, pid: nativePid ?? report.runtime.pid, hostPid: child.pid!, nativeProfile: request.engine === "rust" ? report.runtime.nativeProfile : null, nativeExecutable: request.engine === "rust" ? nativeExecutable! : null, parse: metrics.parse, pipeline: metrics.pipeline, profileTrials: MEMORY_TRIALS, exclusions: "Fixture loading, decoding, and prepared inputs excluded. Completed chunk state released; only final chunk state retained at stage end.", limitations: MEMORY_LIMITATIONS };
 } catch (error) { const message = error instanceof Error ? error.message : String(error); throw Error(`${request.game.gameId}/${request.engine} memory profile: ${message}${diagnostics.trim() ? `\nChild diagnostics (last 32 KiB):\n${diagnostics.trim()}` : ""}`); }
 finally {
  if (onNativeStarted && child) child.off("message", onNativeStarted);
  clearTimeout(deadline);
  if (!succeeded && nativePid !== undefined && child?.pid) { try { if (await psParent(nativePid) === child.pid) process.kill(nativePid, "SIGKILL"); } catch {} }
  if (!succeeded && child && !exited) {
   const { promise, resolve } = Promise.withResolvers<void>();
   const timer = setTimeout(resolve, 5000);
   child.once("close", () => { clearTimeout(timer); resolve(); });
   child.kill("SIGKILL");
   await promise;
  }
  rmSync(directory, { recursive: true, force: true });
 }
}
