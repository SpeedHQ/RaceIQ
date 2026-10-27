import type { AppSettings } from "@raceiq/backend-core/runtime/config/settings";

let originalSettings: AppSettings | null = null;
let fixtureFrames: { frame: Buffer; frameTimeMs?: number }[] = [];
let nextFrame = 0;
let started = false;


/** Initialize the real module-level live recorder with deterministic native LMU frames. */
export async function startLmuOpponentCapture(identity: string, options: { opponents?: boolean } = {}): Promise<void> {
  const load = <T>(name: string, promise: Promise<T>): Promise<T> => {
    process.stderr.write(`[E8 ingress] ${name}: start\n`);
    return promise.then((value) => {
      process.stderr.write(`[E8 ingress] ${name}: complete\n`);
      return value;
    });
  };
  const [{ initDb }, { initGameAdapters }, { initServerGameAdapters }, { registerDriverProfileLapNotifier }, settings, { makeLmuOpponentCapture }, { gunzipSync }, { iterateSessionCaptureRecords }] = await Promise.all([
    load("db/index", import("@raceiq/backend-core/db/index")),
    load("games/init", import("@raceiq/game-catalogs/games/init")),
    load("backend/test-support/games", import("@raceiq/backend/test-support/games")),
    load("driver-profile/lap-notifier", import("@raceiq/backend-core/driver-profile/lap-notifier")),
    load("runtime/config/settings", import("@raceiq/backend-core/runtime/config/settings")),
    load("game-lmu/test-support/opponents", import("@raceiq/game-lmu/test-support/opponents")),
    load("node:zlib", import("node:zlib")),
    load("capture-formats/session/framing", import("@raceiq/capture-formats/session/framing")),
  ]);
  process.stderr.write("[E8 ingress] initDb: start\n");
  await initDb();
  process.stderr.write("[E8 ingress] initDb: complete\n");
  const livePipeline = await load("telemetry/live-pipeline", import("@raceiq/backend-core/telemetry/live-pipeline"));
  if (livePipeline.isSessionActive()) throw new Error("Cannot start LMU opponent fixture while a recorder is active or draining");
  initGameAdapters();
  process.stderr.write("[E8 ingress] initGameAdapters: complete\n");
  initServerGameAdapters();
  process.stderr.write("[E8 ingress] initServerGameAdapters: complete\n");
  registerDriverProfileLapNotifier(() => {});
  if (!originalSettings) originalSettings = settings.loadSettings({ syncLaunchOnLogin: false });
  settings.saveSettings({ ...originalSettings, recordLmuOpponents: true });
  process.stderr.write("[E8 ingress] settings: complete\n");
  const { resetParserState } = await load("games/packet-dispatch", import("@raceiq/backend-core/games/packet-dispatch"));
  resetParserState("lmu");
  fixtureFrames = [...iterateSessionCaptureRecords(gunzipSync(makeLmuOpponentCapture({ identity, ...options })), 0, { strict: true })]
    .flatMap((record) => record.kind === "frame" ? [{ frame: Buffer.from(record.frame), frameTimeMs: record.frameTimeMs }] : []);
  if (fixtureFrames.length === 0) throw new Error("Controlled LMU opponent fixture contains no native frames");
  nextFrame = 0;
  started = true;
  process.stderr.write(`[E8 ingress] ready: ${fixtureFrames.length} frames\n`);
}

/** Feed native source frames through packet parsing and the production module-level ingress. */
export async function feedLmuOpponentFrames(count?: number): Promise<number> {
  if (!started || fixtureFrames.length === 0) throw new Error("LMU opponent capture has not been started");
  const [{ parsePacket }, livePipeline] = await Promise.all([
    import("@raceiq/backend-core/games/packet-dispatch"),
    import("@raceiq/backend-core/telemetry/live-pipeline"),
  ]);
  const frameCount = count ?? fixtureFrames.length - nextFrame;
  if (!Number.isInteger(frameCount) || frameCount < 0 || nextFrame + frameCount > fixtureFrames.length) {
    throw new RangeError(`Invalid LMU opponent frame count ${frameCount}`);
  }
  for (let index = 0; index < frameCount; index++) {
    const input = fixtureFrames[nextFrame++]!;
    const packet = parsePacket(input.frame, input.frameTimeMs);
    if (!packet) throw new Error(`Controlled LMU source frame ${nextFrame - 1} did not parse`);
    await livePipeline.processPacket(packet, input.frame, input.frameTimeMs);
    await livePipeline.drainSessionRecorderWrites();
  }
  return frameCount;
}

/** Read active production pipeline ownership and persisted lap IDs. */
export async function getLmuOpponentCaptureState(): Promise<{ sessionId: number | null; lapIds: number[] }> {
  if (!started) throw new Error("LMU opponent capture has not been started");
  const [{ db }, { laps }, { eq }, { lapDetector }] = await Promise.all([
    import("@raceiq/backend-core/db/index"),
    import("@raceiq/backend-core/db/schema"),
    import("drizzle-orm"),
    import("@raceiq/backend-core/telemetry/live-pipeline"),
  ]);
  const sessionId = lapDetector.session?.sessionId ?? null;
  if (sessionId === null) return { sessionId: null, lapIds: [] };
  const rows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  return { sessionId, lapIds: rows.map(({ id }) => id) };
}

/** Finalize the real direct recorder; index admission remains runtime-owned and asynchronous. */
export async function finalizeLmuOpponentCapture(): Promise<void> {
  if (!started) throw new Error("LMU opponent capture has not been started");
  try {
    const { flushSessionRecorder } = await import("@raceiq/backend-core/telemetry/live-pipeline");
    await flushSessionRecorder();
  } finally {
    if (originalSettings) {
      const { saveSettings } = await import("@raceiq/backend-core/runtime/config/settings");
      saveSettings(originalSettings);
      originalSettings = null;
    }
    fixtureFrames = [];
    nextFrame = 0;
    started = false;
  }
}

