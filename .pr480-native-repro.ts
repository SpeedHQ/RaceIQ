import { mock } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { IRacingCaptureManager } from './apps/backend/src/runtime/iracing-capture';
import { IRacingTelemetrySource as RealSource, type IRacingTelemetrySourceOptions } from './packages/game-iracing/src/source';
import * as platform from './server/runtime/platform/shell';
import * as registry from './server/games/registry';
import { sampleFrame } from './packages/game-iracing/test/support/games/iracing-sdk';

const root = await mkdtemp(join(tmpdir(), 'raceiq-pr480-source-'));
await mkdir(join(root, 'source'));
const commands: boolean[] = [];
const manager = new IRacingCaptureManager({ availability:()=>null, resolveDirectory:()=>join(root,'source'), archiveDirectory:join(root,'archive'), pollIntervalMs:0, shutdownFlushMs:0, setLogging:enabled=>{commands.push(enabled);} });
let dispatchCount = 0;
let source: RealSource | null = null;
const snapshot = { tick: 1, tickCount: 1, sessionInfoUpdate: 1, sessionInfo: '', tickRate: 60, variables: [], values: { ...sampleFrame().values, IsDiskLoggingEnabled:false, IsDiskLoggingActive:false } };
class FixtureSource extends RealSource {
 constructor(options: IRacingTelemetrySourceOptions) {
  super({...options, reader:{start(){},async stop(){},readLatest:()=>snapshot}, registerIdentity:undefined, dispatchRawFrame:async()=>{dispatchCount++;}});
  source = this;
 }
 start() {}
}
mock.module('@raceiq/backend-core/runtime/platform/shell',()=>({...platform,IS_WINDOWS:true}));
mock.module('@raceiq/backend-core/games/registry',()=>({...registry,isGameRunning:(game:string)=>game==='iracing'}));
mock.module('@raceiq/game-iracing/source',()=>({IRacingTelemetrySource:FixtureSource}));
mock.module('./apps/backend/src/runtime/iracing-capture',()=>({IRacingCaptureManager,iracingCaptureManager:manager}));
// Load the supervisor only after replacing platform and hardware module boundaries.
const { startNativeSourceSupervisor } = await import('./apps/backend/src/runtime/native-sources');
const supervisor = startNativeSourceSupervisor(null);
try {
 await manager.connect(true);
 await Bun.sleep(2100);
 assert(source,'Production supervisor must create the iRacing source');
 await (source as RealSource).pollOnce();
 await manager.tick();
 console.log('PRODUCTION_WIRING',JSON.stringify({dispatchCount,commands,state:manager.status().state}));
 assert(dispatchCount>0,'Real source must process supplied SDK snapshot');
 assert.equal(manager.status().state,'waiting-for-iracing');
 assert.deepEqual(commands,[]);
 manager.observe(snapshot,Date.now());
 await manager.tick();
 console.log('CONTROL_OBSERVATION',JSON.stringify({commands,state:manager.status().state}));
 assert.deepEqual(commands,[true]);
 assert.equal(manager.status().state,'waiting-for-recording');
} finally {await supervisor.stop();await rm(root,{recursive:true,force:true});}
