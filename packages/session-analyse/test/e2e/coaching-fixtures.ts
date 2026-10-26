import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext } from "@playwright/test";

const RECORDING_RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "coaching-recording-fixture-runner.ts");

export type CoachingSignal = "brake-drag" | "downshift" | "steering" | "throttle";

export interface CoachingRecording {
  sessionId: number;
  lapIds: number[];
  cleanup(): Promise<void>;
}
export const COACHING_FRAME_COUNT = 600;

export type CoachingDistanceProfile = "variable";


function createRecording(path: string, lapCount: number, signals: readonly CoachingSignal[], omittedChannels: readonly ("distance" | "speed" | "position")[], inputs: readonly ("throttle" | "brake" | "steering" | "rpm")[], distanceProfile?: CoachingDistanceProfile): void {
  const result = spawnSync("bun", [RECORDING_RUNNER, path, JSON.stringify({ lapCount, signals, omittedChannels, inputs, distanceProfile })], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Controlled coaching recording generation failed: ${result.stderr || result.stdout}`);
}

/** Import genuine iRacing source frames through production parser, lap detector and persistence. */
export async function importCoachingRecording(
  request: APIRequestContext,
  options: { label: string; lapCount?: number; signals?: readonly CoachingSignal[]; omittedChannels?: readonly ("distance" | "speed" | "position")[]; inputs?: readonly ("throttle" | "brake" | "steering" | "rpm")[]; distanceProfile?: CoachingDistanceProfile },
): Promise<CoachingRecording> {
  const root = mkdtempSync(join(tmpdir(), "raceiq-coaching-e2e-"));
  const path = join(root, `${options.label}.bin`);
  const lapCount = options.lapCount ?? 3;

  let importedSessionIds: number[] = [];
  try {
    createRecording(path, lapCount, options.signals ?? ["brake-drag", "downshift", "steering", "throttle"], options.omittedChannels ?? [], options.inputs ?? ["throttle", "brake", "steering", "rpm"], options.distanceProfile);
    const response = await request.post("/api/laps/import", {
      multipart: {
        file: { name: `${options.label}.bin`, mimeType: "application/octet-stream", buffer: readFileSync(path) },
        ownership: "mine",
      },
    });
    if (!response.ok()) throw new Error(`Controlled coaching recording import failed: ${response.status()} ${await response.text()}`);
    const payload = await response.json() as { laps: Array<{ lapId: number; sessionId: number; lapNumber: number }> };
    const lapIds = payload.laps.map((lap) => lap.lapId);
    importedSessionIds = [...new Set(payload.laps.map((lap) => lap.sessionId))];
    const sessionIds = importedSessionIds;
    if (sessionIds.length !== 1 || lapIds.length !== lapCount) {
      throw new Error(`Controlled recording imported ${lapIds.length} laps across ${sessionIds.length} sessions; expected ${lapCount} laps in one session`);
    }
    await expect.poll(async () => {
      const allLaps = await request.get("/api/laps?gameId=iracing");
      if (!allLaps.ok()) return `lap metadata status ${allLaps.status()}`;
      const rows = await allLaps.json() as Array<{ id: number; sessionId: number }>;
      const foundIds = new Set(rows.filter((row) => row.sessionId === sessionIds[0]).map((row) => row.id));
      if (!lapIds.every((id) => foundIds.has(id))) return "laps pending";
      const sessions = await request.get("/api/sessions?gameId=iracing");
      if (!sessions.ok()) return `session metadata status ${sessions.status()}`;
      const sessionRows = await sessions.json() as Array<{ id: number; processing?: { state?: string } }>;
      return sessionRows.find((session) => session.id === sessionIds[0])?.processing?.state ?? "session pending";
    }, { timeout: 120_000, intervals: [250, 500, 1_000] }).toBe("ready");
    let cleaned = false;
    return {
      sessionId: sessionIds[0]!,
      lapIds,
      async cleanup() {
        if (cleaned) return;
        const deleted = await request.post("/api/sessions/bulk-delete", { data: { ids: sessionIds } });
        if (!deleted.ok()) throw new Error(`Controlled coaching session cleanup failed: ${deleted.status()} ${await deleted.text()}`);
        cleaned = true;
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (importedSessionIds.length > 0) {
      await request.post("/api/sessions/bulk-delete", { data: { ids: importedSessionIds } }).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
