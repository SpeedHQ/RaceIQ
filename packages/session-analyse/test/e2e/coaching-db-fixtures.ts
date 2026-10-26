import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtime } from "../../../../playwright/config/runtime";
const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "coaching-db-fixture-runner.ts");

function mutate(action: string, id: number, value?: string, extra?: string): string {
  const result = spawnSync("bun", [RUNNER, action, String(id), ...(value === undefined ? [] : [value]), ...(extra === undefined ? [] : [extra])], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: runtime.seeded.dataDir },
  });
  if (result.status !== 0) throw new Error(`Isolated coaching DB fixture ${action} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim().split("\n").at(-1) ?? "";
}

export function setLapInsightSourceFrame(lapId: number, frame: number): { insightVersion: number; finding: Record<string, unknown> } {
  return JSON.parse(mutate("set-source-frame", lapId, "", String(frame))) as { insightVersion: number; finding: Record<string, unknown> };
}

export async function markLapInsightsStale(lapId: number): Promise<void> {
  mutate("stale-insights", lapId);
}

export async function setCaptureSplitStatus(sessionId: number, status: "splitting" | "failed"): Promise<() => Promise<void>> {
  const previous = mutate("split-status", sessionId, status);
  return async () => { mutate("restore-split-status", sessionId, previous || "null"); };
}

export async function clearSessionCapture(sessionId: number): Promise<() => void> {
  const previous = mutate("clear-session-capture", sessionId);
  return () => { mutate("restore-session-capture", sessionId, previous); };
}

export function deleteLapFixture(lapId: number): void {
  mutate("delete-lap", lapId);
}

export async function setLapFixtureState(lapId: number, state: "invalid" | "valid" | "non-pace" | "excluded"): Promise<() => void> {
  const previous = mutate("set-lap-state", lapId, state);
  return () => { mutate("restore-lap-state", lapId, previous); };
}

export function setLapInsightsToInvalidSourceIndices(lapId: number): void {
  mutate("invalid-source-indices", lapId);
}
export function replaceCaptureWithCorruptFixture(sessionId: number): () => void {
  const directory = mkdtempSync(join(runtime.seeded.dataDir, "coaching-corrupt-"));
  const path = join(directory, "invalid-recording.bin");
  writeFileSync(path, Buffer.from("not a recording"));
  let previous: string;
  try {
    previous = mutate("replace-session-capture", sessionId, path);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return () => {
    try {
      const priorCapture = JSON.parse(previous) as string | null;
      mutate("replace-session-capture", sessionId, priorCapture ?? undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
