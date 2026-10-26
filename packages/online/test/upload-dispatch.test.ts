import { describe, expect, test } from "bun:test";
import { OnlineAdapterError } from "../server/adapter";
import { createOnlineUploadDispatcher, type OnlineUploadDispatchPort, type OnlineUploadRow, type OnlineUploadStorage } from "../server/upload-dispatch";
import type { PreparedOnlineLapUpload } from "../server/payload";

const context={accountId:"owner",accountEpoch:"epoch",revision:1,setupUploads:false};
const identity={lapGuid:"guid",originalActivityId:"activity",sourceRevision:"revision",sourceKind:"native_capture" as const,ownerUserId:"owner",driverBindingId:"binding",driverBindingRevision:1};
const row:OnlineUploadRow={lapId:1,gameId:"acc",trackId:"track",carId:"car",lapTimeMs:90000,accountId:"owner",originalActivityId:"activity",lapGuid:"guid",result:null,idempotencyKey:null,identityJson:null,payloadFingerprint:null,reservationToken:null,remoteJobId:null,uploadedAt:null,retryAfter:null};
function harness(options:{key?:string|null;identityJson?:string|null;prepare?:()=>Promise<PreparedOnlineLapUpload>;reserve?:()=>Promise<{reservationToken:string|null;acceptedJobId:string|null}>;upload?:(input:Parameters<OnlineUploadDispatchPort["uploadLap"]>[0])=>Promise<{id:string}|{acceptedJobId:string}>;authorized?:()=>boolean;winner?:()=>boolean;settle?:()=>boolean}={}){
  let stored={...row,idempotencyKey:options.key??null,identityJson:options.identityJson??(options.key?JSON.stringify(identity):null),payloadFingerprint:options.key?"fp":null,reservationToken:options.key?"token":null};
  const calls={prepare:0,reserve:0,upload:0,settle:0,retainedKeys:[] as string[]};
  const storage:OnlineUploadStorage={
    getOnlineUploadWinnerPage:async()=>({items:[{lapId:1,gameId:"acc",trackId:"track",carId:"car",lapTimeMs:90000}],nextCursor:null}),
    readOnlineLapUpload:async()=>options.winner?.()===false?null:stored,
    retainOnlineLapRequest:async(_id,input)=>{calls.retainedKeys.push(input.idempotencyKey);stored={...stored,idempotencyKey:input.idempotencyKey,identityJson:input.identityJson,payloadFingerprint:input.payloadFingerprint,reservationToken:input.reservationToken??stored.reservationToken};return true;},
    settleOnlineLapUpload:async()=>{calls.settle++;return options.settle?.()??true;},setOnlineLapRetryAfter:async()=>true,
  };
  const prepared={...identity,gameId:"acc",trackId:"track",carId:"car",lapId:1,lapTimeMs:90000,recording:new Uint8Array([1]),setup:null,filename:"lap.bin",fingerprint:"fp",codec:null,isSourceCurrent:async()=>true} as unknown as PreparedOnlineLapUpload;
  const port:OnlineUploadDispatchPort={getContext:async()=>context,isAuthorized:()=>options.authorized?.()??true,
    reserveLapUpload:async()=>{calls.reserve++;return options.reserve?.()??{reservationToken:"token",acceptedJobId:null};},
    uploadLap:async(input)=>{calls.upload++;return options.upload?options.upload(input):{id:"remote"};},
    prepareRecording:async()=>{calls.prepare++;return options.prepare?options.prepare():prepared;}};
  return {dispatch:createOnlineUploadDispatcher(port,storage),calls,storage};
}

describe("online upload dispatcher",()=>{
  test("reconciles lost reply with persisted key before attempting source preparation",async()=>{
    const h=harness({key:"018f0f4e-7b00-7000-8000-000000000001",reserve:async()=>({reservationToken:null,acceptedJobId:"accepted"}),prepare:async()=>{throw Error("source unavailable");}});
    expect(await h.dispatch(1)).toEqual({status:"success",error:null});
    expect(h.calls).toMatchObject({reserve:1,prepare:0,settle:1,upload:0});
  });
  test("skips network when current winner changes before reservation",async()=>{
    const h=harness({winner:()=>false});
    expect(await h.dispatch(1)).toEqual({status:"skipped",error:null});
    expect(h.calls).toMatchObject({reserve:0,upload:0});
  });
  test("does not send when prepared source is stale",async()=>{
    const h=harness({prepare:async()=>({...({ ...identity,gameId:"acc",trackId:"track",carId:"car",lapId:1,lapTimeMs:90000,recording:new Uint8Array([1]),setup:null,filename:"lap.bin",fingerprint:"fp",codec:null}),isSourceCurrent:async()=>false} as unknown as PreparedOnlineLapUpload)});
    expect(await h.dispatch(1)).toEqual({status:"skipped",error:null});
    expect(h.calls.upload).toBe(0);
  });
  test("does not send setup after authorization revoked",async()=>{
    const h=harness({authorized:()=>false});
    expect(await h.dispatch(1)).toEqual({status:"skipped",error:null});
    expect(h.calls.upload).toBe(0);
  });
  test("preserves transient classification and Retry-After",async()=>{
    const retryAfter=new Date(Date.now()+60_000).toISOString();
    const h=harness({key:"018f0f4e-7b00-7000-8000-000000000001",reserve:async()=>{throw new OnlineAdapterError("rate_limited",true,retryAfter,429);}});
    expect(await h.dispatch(1)).toMatchObject({status:"retry",error:{retryAfter}});
  });
  test("settles only authoritative hosted terminal rejection",async()=>{
    const h=harness({key:"018f0f4e-7b00-7000-8000-000000000001",reserve:async()=>{throw new OnlineAdapterError("lap_identity_conflict",false,null,409);}});
    expect(await h.dispatch(1)).toMatchObject({status:"rejected"});
    expect(h.calls.settle).toBe(1);
  });
  test("malformed persisted identity skips without reserving or preparing",async()=>{
    const h=harness({key:"018f0f4e-7b00-7000-8000-000000000001",identityJson:"{"});
    expect(await h.dispatch(1)).toEqual({status:"skipped",error:null});
    expect(h.calls).toMatchObject({reserve:0,prepare:0,upload:0});
  });
  test("hosted identity conflict settles; reservation expiry retries",async()=>{
    const conflict=harness({key:"018f0f4e-7b00-7000-8000-000000000001",reserve:async()=>{throw new OnlineAdapterError("lap_identity_conflict",false,null,409);}});
    expect(await conflict.dispatch(1)).toMatchObject({status:"rejected"});
    const expired=harness({key:"018f0f4e-7b00-7000-8000-000000000001",reserve:async()=>{throw new OnlineAdapterError("service_unavailable",true,null,409);}});
    expect(await expired.dispatch(1)).toMatchObject({status:"retry"});
  });
  test("rechecks winner at adapter before-send callback",async()=>{
    let winner=true;
    let callbackRan=false;
    let bodySent=false;
    const key="018f0f4e-7b00-7000-8000-000000000001";
    const h=harness({key,winner:()=>winner,upload:async(input)=>{
      winner=false;
      callbackRan=true;
      if(!await input.isSourceCurrent())throw new OnlineAdapterError("activity_revision_conflict",false);
      bodySent=true;
      return{id:"remote"};
    }});
    expect(await h.dispatch(1)).toEqual({status:"skipped",error:null});
    expect(callbackRan).toBe(true);
    expect(bodySent).toBe(false);
    expect(h.calls.settle).toBe(0);
    expect(new Set(h.calls.retainedKeys)).toEqual(new Set([key]));
  });
  test("setup revocation during preparation prevents send",async()=>{
    let authorized=true;
    const h=harness({authorized:()=>authorized,prepare:async()=>{authorized=false;return{...({ ...identity,gameId:"acc",trackId:"track",carId:"car",lapId:1,lapTimeMs:90000,recording:new Uint8Array([1]),setup:new Uint8Array([2]),filename:"lap.bin",fingerprint:"fp",codec:null}),isSourceCurrent:async()=>true} as unknown as PreparedOnlineLapUpload;}});
    expect(await h.dispatch(1)).toEqual({status:"skipped",error:null});
    expect(h.calls.upload).toBe(0);
  });
});
