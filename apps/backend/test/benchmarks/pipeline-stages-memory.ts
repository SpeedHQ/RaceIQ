import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { MitataStatistics } from "./mitata-harness";

export const MEMORY_TRIALS = 3;
export const MEMORY_LIMITATIONS = "Headline memory is median end-of-stage retained growth with stage state alive and transient returned outputs released, excluding loaded fixtures and prepared inputs. Bun uses post-GC JSC-accounted heap/backing storage. Diagnostic peakAdditionalBytes means sampled post-GC maximum, not a true transient peak; temporary allocations between samples may be missed. GC/runtime/JIT effects remain. Allocator overhead and untracked native/direct C allocations are excluded; allocation churn is not measured. Profile timing discarded.";
export type StageMemory = { samples: { peakAdditionalBytes: number; retainedAdditionalBytes: number }[]; peakAdditionalBytes: number; retainedAdditionalBytes: number };
export type MemoryProfile = { method: "stage-code-memory-v4"; metric: "bun-post-gc-live-heap-bytes"; pid: number; hostPid: number; parse: StageMemory; pipeline: StageMemory; profileTrials: number; exclusions: string; limitations: string };
export type PipelineStage = {
  samplesSeconds: number[];
  medianSeconds: number | null;
  acceptedPackets?: number;
  processedPackets?: number;
  nsPerFrame: number | null;
  nsPerPacket: number | null;
  mitata?: MitataStatistics;
};
export type PipelineGame = { gameId: string; fixture: string; sourceHash: string; workloadHash: string; sourceFrames: number; records: number; contextRecords: number; segmentRecords: number; parse: PipelineStage; pipeline: PipelineStage; memory?: MemoryProfile | { error: string } };
const stageMemorySchema = z.object({ samples: z.array(z.object({ peakAdditionalBytes: z.number().int().nonnegative(), retainedAdditionalBytes: z.number().int().nonnegative() })).length(MEMORY_TRIALS), peakAdditionalBytes: z.number().int().nonnegative(), retainedAdditionalBytes: z.number().int().nonnegative() });
// The internal child runs three memory windows, not three throughput trials.
// Reject timings here rather than allowing profiler overhead into rate reports.
const stageSchema = z.object({ samplesSeconds: z.array(z.number()).length(0), medianSeconds: z.null(), nsPerFrame: z.null(), nsPerPacket: z.null(), mitata: z.never().optional(), acceptedPackets: z.number().int().positive().optional(), processedPackets: z.number().int().positive().optional() });
const childReportSchema = z.object({ config: z.object({ game: z.string(), frames: z.number().int().positive(), trials: z.literal(MEMORY_TRIALS), memory: z.literal("off") }), runtime: z.object({ pid: z.number().int().positive() }), errors: z.array(z.unknown()).length(0), games: z.array(z.object({ gameId: z.string(), sourceHash: z.string(), workloadHash: z.string(), sourceFrames: z.number().int().positive(), records: z.number().int().positive(), contextRecords: z.number().int().nonnegative(), segmentRecords: z.number().int().nonnegative(), parse: stageSchema, pipeline: stageSchema, memory: z.object({ metric: z.literal("bun-post-gc-live-heap-bytes"), parse: stageMemorySchema, pipeline: stageMemorySchema }).optional() })) });
const PROFILE_TIMEOUT_MS = 180_000;
export async function profileBunMemory(request: { runner: string; frames: number; game: PipelineGame }): Promise<MemoryProfile> {
 const directory = mkdtempSync(join(tmpdir(), "raceiq-pipeline-memory-")); const output = join(directory, "report.json"); let child: ChildProcess | undefined, diagnostics = "", exited = false, succeeded = false, deadline: NodeJS.Timeout | undefined;
 try {
  child = spawn(process.execPath, [request.runner, `--game=${request.game.gameId}`, `--frames=${request.frames}`, `--trials=${MEMORY_TRIALS}`, "--memory=off", `--output=${output}`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RACEIQ_PIPELINE_MEMORY_CHILD: "1", RACEIQ_PIPELINE_MEMORY_TEMP_DIR: directory } });
  child.stdout!.on("data", (b) => { diagnostics = (diagnostics + b.toString()).slice(-32768); }); child.stderr!.on("data", (b) => { diagnostics = (diagnostics + b.toString()).slice(-32768); });
  const { promise: failTimer, reject: rejectDeadline } = Promise.withResolvers<never>(); deadline = setTimeout(() => rejectDeadline(Error(`Memory profile timed out after ${PROFILE_TIMEOUT_MS} ms`)), PROFILE_TIMEOUT_MS);
  const { promise: closed, resolve, reject } = Promise.withResolvers<void>(); child.once("error", reject); child.once("close", (code, signal) => { exited = true; if (code === 0) resolve(); else reject(Error(`Memory child exited (${code ?? signal})`)); });
  await Promise.race([closed, failTimer]);
  const parsed = childReportSchema.safeParse(JSON.parse(readFileSync(output, "utf8"))); if (!parsed.success) throw Error(`Memory child report validation failed: ${parsed.error.message}`);
  const report = parsed.data, game = report.games[0]!;
  if (report.config.game !== request.game.gameId || report.config.frames !== request.frames || report.runtime.pid !== child.pid) throw Error("Memory child report configuration/runtime differs from request");
  for (const key of ["gameId", "sourceHash", "workloadHash", "sourceFrames", "records", "contextRecords", "segmentRecords"] as const) if (game[key] !== request.game[key]) throw Error(`Memory child ${key} differs from throughput workload`);
  if (game.parse.acceptedPackets !== request.game.parse.acceptedPackets || game.pipeline.processedPackets !== request.game.pipeline.processedPackets || game.pipeline.processedPackets !== game.parse.acceptedPackets) throw Error("Memory child packet count validation failed");
  if (!game.memory) throw Error("Memory child omitted code-memory measurements");
  succeeded = true;
  return { method: "stage-code-memory-v4", metric: "bun-post-gc-live-heap-bytes", pid: report.runtime.pid, hostPid: child.pid!, parse: game.memory.parse, pipeline: game.memory.pipeline, profileTrials: MEMORY_TRIALS, exclusions: "Fixture loading, decoding, and prepared inputs excluded. Completed chunk state released; only final chunk state retained at stage end.", limitations: MEMORY_LIMITATIONS };
 } catch (error) { const message = error instanceof Error ? error.message : String(error); throw Error(`${request.game.gameId} memory profile: ${message}${diagnostics.trim() ? `\nChild diagnostics (last 32 KiB):\n${diagnostics.trim()}` : ""}`); }
 finally { clearTimeout(deadline); if (!succeeded && child && !exited) { const { promise, resolve } = Promise.withResolvers<void>(); const timer = setTimeout(resolve, 5000); child.once("close", () => { clearTimeout(timer); resolve(); }); child.kill("SIGKILL"); await promise; } rmSync(directory, { recursive: true, force: true }); }
}
