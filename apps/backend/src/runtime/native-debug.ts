import { PHYSICS, GRAPHICS, STATIC } from "@raceiq/capture-formats/acc/structs";
import { GRAPHICS_EVO, STATIC_EVO } from "@raceiq/capture-formats/ac-evo/structs";
import { getRecorderEngine, getRecordingEngineKind, runRecordingJob } from "@raceiq/backend-core/runtime/recorder-engine";
import { getAccReader, getAcEvoReader } from "./live-readers";

type DebugBuffers = { physics: Buffer; graphics: Buffer; staticData: Buffer };

/** Diagnostic demand never starts a second native reader in Rust mode. */
export async function readKunosDebugBuffers(gameId: "acc" | "ac-evo"): Promise<DebugBuffers | null> {
  return runRecordingJob(async () => {
    if (getRecordingEngineKind() === "bun") {
      const reader = gameId === "acc" ? getAccReader() : getAcEvoReader();
      return reader?.getDebugBuffers?.() ?? null;
    }
    const engine = getRecorderEngine();
    if (!engine) throw new Error("Rust recorder is not running");
    const result = await engine.request<Record<string, unknown>>("debug-demand", { gameId, enabled: true });
    if (result.connected === false) return null;
    if (result.connected !== true) throw new Error("Invalid recorder diagnostic connection state");
    const buffers: Buffer[] = [];
    for (const field of ["physics", "graphics", "static"] as const) {
      const encoded = result[field];
      if (typeof encoded !== "string" || encoded.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error(`Invalid recorder diagnostic ${field} snapshot`);
      }
      buffers.push(Buffer.from(encoded, "base64"));
    }
    const [physics, graphics, staticData] = buffers as [Buffer, Buffer, Buffer];
    if (physics.length !== PHYSICS.SIZE || graphics.length !== (gameId === "acc" ? GRAPHICS.SIZE : GRAPHICS_EVO.SIZE)
      || staticData.length !== (gameId === "acc" ? STATIC.SIZE : STATIC_EVO.SIZE)) {
      throw new Error("Invalid recorder diagnostic snapshot layout");
    }
    return { physics, graphics, staticData };
  });
}
