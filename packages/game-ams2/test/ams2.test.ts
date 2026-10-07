import { getAMS2TrackLength } from "@raceiq/game-ams2-metadata/index";
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMS2_LAYOUT as L, AMS2_MEMORY_SIZE, PARTICIPANT_OFFSET as P } from "../src/layout";
import { encodeAMS2Frame, decodeAMS2Frame } from "../src/frame";
import { normalizeAMS2Frame } from "../src/normalizer";
import { AMS2TelemetrySource } from "../src/source";
import { ams2ServerAdapter } from "../src/index";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { SparseSessionRecorder } from "@raceiq/backend-core/session-capture/sparse-recorder";
import { iterateSessionFrames } from "@raceiq/backend-core/session-capture/framing";
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
  test("decodes native units and rejects malformed or unsupported frames",()=>{
    const b=fixture(); const p=packet(b);
    expect(p).toMatchObject({gameId:"ams2",Speed:50,Fuel:40,Accel:191,Gear:3,IsRaceOn:1});
    expect(p.TirePressureFrontLeft).toBeCloseTo(29.0075,3);expect(p.BrakeTempFrontLeft).toBe(400);
    expect(p.ams2?.trackName).toBe("Interlagos");
    expect(getAMS2TrackLength(p.TrackOrdinal)).toBe(p.ams2?.trackLengthM);
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
