import { getAMS2TrackLength } from "@raceiq/game-ams2-metadata/index";
import { describe, test, expect, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMS2_LAYOUT as L, AMS2_MEMORY_SIZE, PARTICIPANT_OFFSET as P } from "../src/layout";
import { encodeAMS2Frame, decodeAMS2Frame } from "../src/frame";
import { normalizeAMS2Frame } from "../src/normalizer";
import { AMS2TelemetrySource } from "../src/source";
import { ams2ServerAdapter } from "../src/index";
import { classifyAMS2PitCycle, resolveAMS2InvalidReason } from "../src/lap-validity";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import { registerGame } from "@raceiq/shared/games/registry";
registerGame(ams2ServerAdapter);
function fixture(): Buffer {
  const b = Buffer.alloc(AMS2_MEMORY_SIZE);
  b.writeUInt32LE(14,L.mVersion); b.writeUInt32LE(2,L.mGameState);
  b.writeUInt32LE(5,L.mSessionState); b.writeInt32LE(1,L.mNumParticipants);
  b[P]=1; b.write("Formula Ultimate",L.mCarName); b.write("Interlagos",L.mTrackLocation);
  b.writeFloatLE(3000,L.mTrackLength); b.writeUInt32LE(1,P+92);
  b.writeFloatLE(50,L.mSpeed); b.writeFloatLE(.5,L.mFuelLevel); b.writeFloatLE(80,L.mFuelCapacity);
  b.writeFloatLE(.75,L.mUnfilteredThrottle); b.writeInt32LE(3,L.mGear);
  b.writeFloatLE(200,L.mAirPressure); b.writeFloatLE(400,L.mBrakeTempCelsius);
  b.writeUInt32LE(2,L.mSequenceNumber); return b;
}
const packet = (b:Buffer,t=1800000000000) => normalizeAMS2Frame(encodeAMS2Frame(b,t,1))!;
describe("AMS2 native capture",()=>{
  test("keeps captured grid starts eligible without losing pit-cycle or partial-start exclusions", () => {
    const start = packet(fixture());
    const later = { ...start, CurrentLap: 60 };
    expect(classifyAMS2PitCycle([start, later], 0)).toBeNull();
    expect(classifyAMS2PitCycle([{ ...start, CurrentLap: 10 }, later], 0)).toBe("outlap");
    expect(classifyAMS2PitCycle([{ ...start, LapNumber: 2 }, later], 0)).toBe("outlap");
    expect(classifyAMS2PitCycle([{ ...start, ams2: { ...start.ams2!, sessionType: "practice" } }, later], 0)).toBe("outlap");
    const pit = { ...start, ams2: { ...start.ams2!, inPits: true } };
    expect(classifyAMS2PitCycle([pit, later], 0)).toBe("outlap");
    expect(classifyAMS2PitCycle([start, pit], 0)).toBe("inlap");
    expect(classifyAMS2PitCycle([pit, pit], 0)).toBe("pit lap");
    expect(classifyAMS2PitCycle([pit, later], 1)).toBe("outlap");
  });
  test("ignores a cleared first-race-lap grid flag but preserves later invalidations", () => {
    const sample = (invalid: boolean, time: number, lap = 1, session = 5) => {
      const b = fixture();
      b[L.mLapInvalidated] = invalid ? 1 : 0;
      b.writeFloatLE(time, L.mCurrentTime);
      b.writeUInt32LE(lap, P + 92);
      b.writeUInt32LE(session, L.mSessionState);
      return packet(b);
    };
    expect(resolveAMS2InvalidReason([sample(true, -1), sample(true, 10), sample(false, 11)])).toBeNull();
    expect(resolveAMS2InvalidReason([sample(true, -1), sample(false, 11), sample(true, 30), sample(false, 31)])).toBe("game-invalidated");
    expect(resolveAMS2InvalidReason([sample(true, -1), sample(true, 60)])).toBe("game-invalidated");
    expect(resolveAMS2InvalidReason([sample(true, 10), sample(false, 11)])).toBe("game-invalidated");
    expect(resolveAMS2InvalidReason([sample(false, 0), sample(true, 10), sample(false, 11)])).toBe("game-invalidated");
    for (const [lap, session] of [[2, 5], [1, 1], [1, 3]]) {
      expect(resolveAMS2InvalidReason([sample(true, -1, lap, session), sample(false, 11, lap, session)])).toBe("game-invalidated");
    }
  });
  test("starts a fresh untimed AMS2 lap without reporting a race restart at the start line", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
    for (const nextTime of [-1, 0.02]) {
      const db = new CapturingDbAdapter();
      const detector = ams2ServerAdapter.createLapDetector({ db });
      for (let i = 0; i < 40; i++) {
        const b = fixture();
        b.writeUInt32LE(1, L.mSessionState); // Time Trial reports practice.
        b.writeFloatLE(-1, L.mCurrentTime);
        b.writeFloatLE(-1, L.mLastLapTime);
        b.writeFloatLE(2980 + i / 2, P + 80);
        await detector.feed(packet(b, 1800000000000 + i * 10));
      }
      const b = fixture();
      b.writeUInt32LE(1, L.mSessionState);
      b.writeFloatLE(nextTime, L.mCurrentTime);
      b.writeFloatLE(-1, L.mLastLapTime);
      b.writeFloatLE(0, P + 80);
      await detector.feed(packet(b, 1800000000400));
      expect(detector.getDebugState!().lapBufferLength).toBe(1);
      expect(db.sessions).toHaveLength(1);
      expect(db.laps).toHaveLength(0);
    }
    expect(log.mock.calls.filter(call => String(call[0]).includes("Race restart detected"))).toHaveLength(0);
    expect(log.mock.calls.filter(call => String(call[0]).includes("Untimed start-line crossing"))).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  test("still discards AMS2 buffers for timed restarts, teleports and ambiguous gaps", async () => {
    for (const kind of ["timed-restart", "teleport", "gap", "mid-lap"] as const) {
      const detector = ams2ServerAdapter.createLapDetector({ db: new CapturingDbAdapter() });
      for (let i = 0; i < 40; i++) {
        const b = fixture();
        b.writeFloatLE(kind === "timed-restart" ? 20 : -1, L.mCurrentTime);
        b.writeFloatLE(-1, L.mLastLapTime);
        b.writeFloatLE(kind === "mid-lap" ? 1500 : 2999, P + 80);
        await detector.feed(packet(b, 1800000000000 + i * 10));
      }
      const b = fixture();
      b.writeFloatLE(0, L.mCurrentTime);
      b.writeFloatLE(-1, L.mLastLapTime);
      if (kind === "teleport") b.writeFloatLE(200, P + 68);
      await detector.feed(packet(b, kind === "gap" ? 1800000010000 : 1800000000400));
      expect(detector.getDebugState!().lapBufferLength).toBe(1);
    }
  });
  test("capture diagnostics distinguish busy processing, empty reads, duplicates and rejected frames", async () => {
    let memory: Buffer | null = fixture();
    let release!: () => void;
    const source = new AMS2TelemetrySource({
      reader: { start() {}, async stop() {}, readLatest: () => memory },
      registerIdentity: async () => {},
      dispatchRawFrame: async () => new Promise<void>(resolve => { release = resolve; }),
    });
    const first = source.pollOnce();
    // Identity registration yields before dispatch begins.
    await Promise.resolve();
    expect(await source.pollOnce()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await source.pollOnce()).toBe(false);
    memory!.writeUInt32LE(3, L.mSequenceNumber);
    expect(await source.pollOnce()).toBe(false);
    memory!.writeUInt32LE(4, L.mSequenceNumber);
    memory!.writeUInt32LE(15, L.mVersion);
    expect(await source.pollOnce()).toBe(false);
    memory = null;
    expect(await source.pollOnce()).toBe(false);
    expect(source.getDiagnostics()).toMatchObject({
      polls: 6, processingBusy: 1, noSnapshot: 1, duplicates: 1,
      writerBusy: 1, malformed: 1, dispatched: 1, errors: 0,
    });
    await source.stop();
  });
  test("decodes native units and rejects malformed or unsupported frames",()=>{
    const b=fixture(); const p=packet(b);
    expect(p).toMatchObject({gameId:"ams2",Speed:50,Fuel:40,Accel:191,Gear:3,IsRaceOn:1});
    expect(p.TirePressureFrontLeft).toBeCloseTo(29.0075,3);expect(p.BrakeTempFrontLeft).toBe(400);
    expect(p.ams2?.trackName).toBe("Interlagos");
    expect(typeof p.carId).toBe("string");
    expect(typeof p.trackId).toBe("string");
    expect(getAMS2TrackLength(p.trackId)).toBe(p.ams2?.trackLengthM);
    expect(decodeAMS2Frame(Buffer.alloc(10))).toBeNull();
    b.writeUInt32LE(15,L.mVersion); expect(packet(b)).toBeNull();
    b.writeUInt32LE(14,L.mVersion); b.writeInt32LE(64,L.mViewedParticipantIndex); expect(packet(b)).toBeNull();
  });
  test("exposes supported semantics and keeps missing slip unavailable",()=>{
    const ids=["fuel.fuel", "tires.tire-pressure", "timing.track-length", "race.on-pit-road", "tires.tire-slip-ratio"];
    const resolver=compileTelemetryResolver(TELEMETRY_CATALOG,{simulator:"ams2",requested:ids.map(semanticId=>({semanticId}))});
    const frame=resolver.createFrameView(packet(fixture()),{timestamp:{domain:"session",milliseconds:1000},updateSequence:1n});
    expect(frame.resolveValue(resolver.slot(ids[0])).value).toBe(40);
    expect(frame.resolveValue(resolver.slot(ids[2])).value).toBe(3000);
    expect(frame.resolveValue(resolver.slot(ids[3])).value).toBe(false);
    expect(frame.resolveValue(resolver.slot(ids[4])).state).toBe("missing");
  });
  test("pauses and replay do not appear as driving",()=>{
    const b=fixture(); for(const state of [1,3,6,7]) {b.writeUInt32LE(state,L.mGameState);expect(packet(b).IsRaceOn).toBe(0);}
  });
  test("deduplicates snapshots and preserves immutable raw bytes",async()=>{
    const b=fixture(), frames:Buffer[]=[];
    const source=new AMS2TelemetrySource({reader:{start(){},async stop(){},readLatest:()=>b},registerIdentity:async()=>{},dispatchRawFrame:async f=>{frames.push(f);}});
    expect(await source.pollOnce()).toBe(true); expect(await source.pollOnce()).toBe(false);
    b.writeUInt32LE(4,L.mSequenceNumber);b.writeFloatLE(51,L.mSpeed);
    expect(await source.pollOnce()).toBe(true);
    expect(normalizeAMS2Frame(frames[0])?.Speed).toBe(50); expect(normalizeAMS2Frame(frames[1])?.Speed).toBe(51);
    b.writeUInt32LE(5,L.mSequenceNumber); expect(await source.pollOnce()).toBe(false); await source.stop();
  });
  test("round trips sparse captures across checkpoints without changing frames",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"ams2-")),path=join(dir,"capture.bin");
    const recorder=new SparseSessionRecorder("ams2"), frames:Buffer[]=[];
    try {recorder.start(path);recorder.writeMetaFrame();
      for(let i=0;i<260;i++){const b=fixture();b.writeUInt32LE(i*2,L.mSequenceNumber);b.writeFloatLE(i/10,L.mCurrentTime);const f=encodeAMS2Frame(b,1800000000000+i*10,1);frames.push(f);recorder.writeRecord(f);}
      await recorder.stop();expect([...iterateSessionFrames(readFileSync(path))]).toEqual(frames);
    } finally {await recorder.stop();rmSync(dir,{recursive:true,force:true});}
  });
  test("records two completed laps with native lap times",async()=>{
    const db=new CapturingDbAdapter();const detector=ams2ServerAdapter.createLapDetector({db});
    for(let lap=1;lap<=3;lap++)for(let i=0;i<300;i++){
      const b=fixture();b.writeUInt32LE(lap,P+92);b.writeUInt32LE(lap-1,P+88);b.writeFloatLE(i*10,P+80);b.writeFloatLE(i*.2,L.mCurrentTime);b.writeFloatLE(lap>1?60:0,L.mLastLapTime);
      await detector.feed(packet(b,1800000000000+((lap-1)*300+i)*200));
    }
    const b=fixture();b.writeUInt32LE(4,P+92);b.writeUInt32LE(3,P+88);b.writeFloatLE(60,L.mLastLapTime);await detector.feed(packet(b,1800000180000));
    expect(db.sessions[0]?.gameId).toBe("ams2");expect(db.sessions[0]?.sessionType).toBe("race");
    expect(db.laps.filter(l=>l.lapTime===60)).toHaveLength(3);
    expect(db.laps[0]?.isValid).toBe(true);
    expect(db.laps.slice(1).every(l=>l.isValid)).toBe(true);
    await detector.finalizeCurrentSession?.();
  });
});


test("does not dispatch retained car readings from AMS2 menus and resumes on track", async () => {
  const memory = fixture();
  const frames: Buffer[] = [];
  const source = new AMS2TelemetrySource({
    reader: { start() {}, async stop() {}, readLatest: () => memory },
    registerIdentity: async () => {},
    dispatchRawFrame: async raw => { frames.push(raw); },
  });
  try {
    expect(await source.pollOnce()).toBe(true);
    for (const state of [1, 5, 6, 0]) {
      memory.writeUInt32LE(state, L.mGameState);
      memory.writeUInt32LE(memory.readUInt32LE(L.mSequenceNumber) + 2, L.mSequenceNumber);
      expect(await source.pollOnce()).toBe(false);
    }
    expect(frames).toHaveLength(1);
    memory.writeUInt32LE(2, L.mGameState);
    memory.writeUInt32LE(20, L.mSequenceNumber);
    expect(await source.pollOnce()).toBe(true);
    expect(frames).toHaveLength(2);
    expect(decodeAMS2Frame(frames[1])!.epoch).toBeGreaterThan(decodeAMS2Frame(frames[0])!.epoch);
  } finally { await source.stop(); }
});

test("rotates AMS2 heading so the arrow follows the car's forward world direction",()=>{
  const memory=fixture();memory.writeFloatLE(0,L.mOrientation+4);
  const p=packet(memory);const direction=ams2ServerAdapter.carForwardOffset(p.Yaw);
  expect(direction[0]).toBeCloseTo(0,6);expect(direction[1]).toBeCloseTo(-1,6);
  memory.writeFloatLE(Math.PI/2,L.mOrientation+4);
  const turned=ams2ServerAdapter.carForwardOffset(packet(memory).Yaw);
  expect(turned[0]).toBeCloseTo(-1,6);expect(turned[1]).toBeCloseTo(0,6);
});
