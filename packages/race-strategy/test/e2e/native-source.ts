import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";

/** Native FM Dash packets exercise the real UDP parser and pipeline, not an API mock. */
export interface NativeLap {
  fuelUsed: number;
  wear: [number, number, number, number];
  /** Deliberately unavailable individual channels retain native sentinel values. */
  missingWheel?: number;
  serviceBefore?: { fuel: number; wear: [number, number, number, number] };
}
export interface NativeRun {
  carId: number;
  trackId?: number;
  pi?: number;
  firstLap?: number;
  timestampMs?: number;
  initialFuel?: number;
  initialWear?: [number, number, number, number];
  laps: NativeLap[];
}

export function* nativeRunFrames(run: NativeRun): Generator<Buffer> {
  const framesPerLap = 240;
  const secondsPerLap = 60;
  const startMs = run.timestampMs ?? 1_000;
  const firstLap = run.firstLap ?? 1;
  let fuel = run.initialFuel ?? 0.9;
  let wear = run.initialWear ?? [0.1, 0.1, 0.1, 0.1];
  let elapsed = 0;
  for (let lapIndex = 0; lapIndex <= run.laps.length; lapIndex++) {
    const lap = run.laps[lapIndex];
    if (lap?.serviceBefore) {
      fuel = lap.serviceBefore.fuel;
      wear = [...lap.serviceBefore.wear];
    }
    // One final boundary packet closes the last complete lap, without inventing a full next lap.
    const frameCount = lap ? framesPerLap : 1;
    for (let frame = 0; frame < frameCount; frame++) {
      const progress = frame / (framesPerLap - 1);
      const packet = Buffer.alloc(331);
      packet.writeInt32LE(1, 0);
      packet.writeUInt32LE(startMs + Math.round(elapsed * 1_000), 4);
      packet.writeFloatLE(8_000, 8);
      packet.writeFloatLE(800, 12);
      packet.writeFloatLE(5_000, 16);
      packet.writeInt32LE(run.carId, 212);
      packet.writeInt32LE(3, 216);
      packet.writeInt32LE(run.pi ?? 800, 220);
      packet.writeInt32LE(1, 224);
      packet.writeInt32LE(8, 228);
      packet.writeFloatLE(Math.sin(progress * Math.PI * 2) * 477, 232);
      packet.writeFloatLE(Math.cos(progress * Math.PI * 2) * 477, 240);
      packet.writeFloatLE(50, 244);
      packet.writeFloatLE(fuel - (lap?.fuelUsed ?? 0) * progress, 276);
      packet.writeFloatLE((firstLap - 1 + lapIndex + progress) * 3_000, 280);
      packet.writeFloatLE(firstLap + lapIndex > 1 ? secondsPerLap : 0, 284);
      packet.writeFloatLE(firstLap + lapIndex > 1 ? secondsPerLap : 0, 288);
      packet.writeFloatLE(progress * secondsPerLap, 292);
      packet.writeFloatLE((firstLap - 1) * secondsPerLap + elapsed, 296);
      packet.writeUInt16LE(firstLap + lapIndex, 300);
      packet.writeUInt8(1, 302);
      packet.writeUInt8(180, 303);
      packet.writeUInt8(4, 307);
      for (let wheel = 0; wheel < 4; wheel++) {
        packet.writeFloatLE(lap?.missingWheel === wheel ? -1 : wear[wheel]! + (lap?.wear[wheel] ?? 0) * progress, 311 + wheel * 4);
      }
      packet.writeInt32LE(run.trackId ?? 5, 327);
      yield packet;
      elapsed += secondsPerLap / framesPerLap;
    }
    if (lap) {
      fuel -= lap.fuelUsed;
      wear = [wear[0] + lap.wear[0], wear[1] + lap.wear[1], wear[2] + lap.wear[2], wear[3] + lap.wear[3]];
    }
  }
}

/** Settle the detector's rate admission using stationary native telemetry, not a measured warm-up lap. */
export async function primeNativeRun(run: NativeRun, port: number, apiURL: string): Promise<void> {
  const first = nativeRunFrames(run).next().value!;
  const statusSchema = z.object({
    type: z.literal("status"), udpPps: z.number(), isRaceOn: z.boolean(),
    currentSession: z.object({ carId: z.string(), trackId: z.string() }).nullable(),
  });
  const status = new WebSocket(`${apiURL.replace("http:", "ws:")}/ws`);
  const socket = createSocket("udp4");
  let stableWindows = 0;
  let connectionFailed = false;
  status.addEventListener("error", () => { connectionFailed = true; });
  status.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const result = statusSchema.safeParse(JSON.parse(event.data));
    if (!result.success) return;
    const value = result.data;
    stableWindows = value.isRaceOn && value.udpPps >= 30 && value.currentSession?.carId === String(run.carId) &&
      value.currentSession.trackId === String(run.trackId ?? 5) ? stableWindows + 1 : 0;
  });
  try {
    const deadline = Date.now() + 20_000;
    while (stableWindows < 2) {
      if (connectionFailed || Date.now() >= deadline) throw new Error("Native telemetry did not reach two admitted rate windows");
      await new Promise<void>((accept, reject) => socket.send(first, port, "127.0.0.1", (error) => error ? reject(error) : accept()));
      await delay(6);
    }
  } finally {
    socket.close();
    status.close();
  }
}

export async function ingestNativeRun(run: NativeRun, port = Number(process.env.PW_SEEDED_E2E_UDP_PORT ?? "15320")): Promise<void> {
  const socket = createSocket("udp4");
  const send = (packet: Buffer) => new Promise<void>((resolveSend, reject) => {
    socket.send(packet, port, "127.0.0.1", (error) => error ? reject(error) : resolveSend());
  });
  try {
    for (const packet of nativeRunFrames(run)) {
      await send(packet);
      await delay(6);
    }
  } finally {
    socket.close();
  }
}

/** Publish runner-owned source segments, including a real canonical segment marker, for production reprocessing. */
export async function writeSegmentedNativeCapture(dataDir: string, sessionId: number, segments: readonly (readonly Buffer[])[]): Promise<void> {
  const rawFile = resolve(dataDir, "a4-segmented-source.capture");
  await mkdir(dataDir, { recursive: true });
  const records = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
  for (let segment = 0; segment < segments.length; segment++) {
    if (segment > 0) records.push(encodeSegmentBoundaryFrame());
    for (const frame of segments[segment]!) records.push(encodeFrameLength(frame.length), frame);
  }
  await writeFile(rawFile, Buffer.concat(records));
  const database = resolve(dataDir, "app.db");
  const update = spawn("bun", ["-e",
    'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); db.run("UPDATE sessions SET raw_file=?, capture_format_version=1, capture_layout_version=NULL, capture_manifest_file=NULL, capture_archive_file=NULL WHERE id=?", [process.argv[3], Number(process.argv[2])]); db.close();',
    database, String(sessionId), rawFile]);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    update.once("error", reject);
    update.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`Failed to publish segmented native capture for session ${sessionId}`);
}
