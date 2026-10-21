import { describe,expect,test } from "bun:test";
import type { Hono } from "hono";
import { createCloudLapImportController } from "../../src/integrations/cloud-lap-import-controller";
import { getAccTracks } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { getAllAccCars } from "@raceiq/game-acc-metadata/racing/cars/acc";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";

const context={accountEpoch:"epoch-a",expectedRevision:0};
const selection={gameId:"acc",trackId:String(getAccTracks().keys().next().value),carId:String(getAllAccCars()[0]!.id)};
const lapGuid="018f0000-0000-7000-8000-000000000001";
const lap={id:10,gameId:"acc",sessionId:20};
const headers={"content-type":"application/json","X-Game-Id":"acc"};
const allowCommunity={
  getCommunityEntitlement:async()=>({allowed:true as const,accountEpoch:context.accountEpoch,onlineRevision:context.expectedRevision}),
  isCommunityEntitlementCurrent:async(candidate:{accountEpoch:string;onlineRevision:number})=>candidate.accountEpoch===context.accountEpoch&&candidate.onlineRevision===context.expectedRevision,
  isCommunityEntitlementCurrentSync:(candidate:{accountEpoch:string;onlineRevision:number})=>candidate.accountEpoch===context.accountEpoch&&candidate.onlineRevision===context.expectedRevision,
};
interface TestController {routes:Hono}
async function state(controller:TestController):Promise<CloudLapImportState>{
  const response=await controller.routes.request(`/api/online/lap-import?${new URLSearchParams({accountEpoch:context.accountEpoch,expectedRevision:String(context.expectedRevision)})}`);
  return response.json() as Promise<CloudLapImportState>;
}
async function complete(controller:TestController):Promise<CloudLapImportState>{
  for(let turn=0;turn<30;turn++){const current=await state(controller);if(current.status==="complete")return current;await Promise.resolve();}
  throw new Error("Import did not complete");
}
function start(controller:TestController,lapId:string){
  return controller.routes.request("/api/online/lap-import",{method:"POST",headers,body:JSON.stringify({...context,lapId,lapGuid,trackId:selection.trackId,carId:selection.carId})});
}
function ack(controller:TestController,activationId:number|null){
  return controller.routes.request("/api/online/lap-import/ack",{method:"POST",headers,body:JSON.stringify({...context,activationId})});
}

describe("Community exact selection and activation authorization",()=>{
  test("GET preserves completion until matching ack; ack advances queued work",async()=>{
    let imported=0;
    const controller=createCloudLapImportController({...allowCommunity,getAccessToken:async()=>"token",importLap:async(input)=>{
      await input.assertAuthorized();input.onIdentity({...selection,lapGuid});imported++;return lap;
    }});
    expect((await start(controller,"first")).status).toBe(202);
    const first=await complete(controller);
    expect(first).toMatchObject({access:context,lapGuid,selection,localLap:lap});
    await start(controller,"second");
    expect((await state(controller)).activationId).toBe(first.activationId);
    expect(imported).toBe(1);
    expect((await ack(controller,first.activationId!+1)).status).toBe(409);
    expect((await ack(controller,first.activationId)).status).toBe(200);
    const second=await complete(controller);
    expect(second.activationId).not.toBe(first.activationId);
    expect(imported).toBe(2);
  });
  test("ack with no queued intent clears activation; later GET cannot rearm it",async()=>{
    const controller=createCloudLapImportController({...allowCommunity,getAccessToken:async()=>"token",importLap:async(input)=>{input.onIdentity({...selection,lapGuid});return lap;}});
    await start(controller,"first");const completed=await complete(controller);
    expect((await ack(controller,completed.activationId)).status).toBe(200);
    expect(await state(controller)).toMatchObject({status:"idle",localLap:null,activationId:null,access:null,lapGuid:null,selection:null});
    expect((await ack(controller,completed.activationId)).status).toBe(409);
  });
  test("one denied entitlement blocks start, retry, reads and URL activation",async()=>{
    let imported=0;
    const controller=createCloudLapImportController({getCommunityEntitlement:async()=>({allowed:false,error:{code:"sharing_required",retryable:false,retryAfter:null}}),isCommunityEntitlementCurrent:async()=>false,isCommunityEntitlementCurrentSync:()=>false,getAccessToken:async()=>"token",importLap:async()=>{imported++;return lap;}});
    const started=await start(controller,"denied");expect(started.status).toBe(403);
    expect(await started.json()).toMatchObject({status:"error",localLap:null,access:null,error:{code:"sharing_required"}});
    expect((await controller.routes.request("/api/online/lap-import/retry",{method:"POST",headers,body:JSON.stringify({...context,activationId:1})})).status).toBe(403);
    expect((await state(controller)).error?.code).toBe("sharing_required");
    expect((await controller.dispatchCloudLapImport("raceiq://import?url=https%3A%2F%2Fraceiq.snazzie.space%2Fapi%2Fv1%2Flaps%2Fcloud-lap%2Fimport.zip")).status).toBe("error");
    expect(imported).toBe(0);
  });
  test("revocation while downloading never exposes cached completion or activation",async()=>{
    let allowed=true;
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const controller=createCloudLapImportController({...allowCommunity,getCommunityEntitlement:async()=>allowed?{allowed:true,accountEpoch:context.accountEpoch,onlineRevision:0}:{allowed:false,error:{code:"sharing_required",retryable:false,retryAfter:null}},isCommunityEntitlementCurrent:async()=>allowed,isCommunityEntitlementCurrentSync:()=>allowed,getAccessToken:async()=>"token",importLap:async(input)=>{
      input.onIdentity({...selection,lapGuid});entered.resolve();await release.promise;await input.assertAuthorized();return lap;
    }});
    expect((await start(controller,"cloud-lap")).status).toBe(202);await entered.promise;
    allowed=false;release.resolve();
    expect((await state(controller)).localLap).toBeNull();
    for(let turn=0;turn<10;turn++)await Promise.resolve();
    expect(await state(controller)).toMatchObject({status:"error",localLap:null,activationId:null,access:null});
  });
  test("stale account context cannot retry a previously admitted intent",async()=>{
    let epoch="epoch-a",attempts=0;
    const controller=createCloudLapImportController({getCommunityEntitlement:async()=>({allowed:true,accountEpoch:epoch,onlineRevision:0}),isCommunityEntitlementCurrent:async candidate=>candidate.accountEpoch===epoch,isCommunityEntitlementCurrentSync:candidate=>candidate.accountEpoch===epoch,getAccessToken:async()=>"token",importLap:async()=>{attempts++;throw new Error("temporary");}});
    await start(controller,"old-intent");for(let turn=0;turn<10;turn++)await Promise.resolve();
    const failed=await state(controller);epoch="epoch-b";
    const retry=await controller.routes.request("/api/online/lap-import/retry",{method:"POST",headers,body:JSON.stringify({...context,activationId:failed.activationId})});
    expect(retry.status).toBe(409);expect(attempts).toBe(1);
    expect(await retry.json()).toMatchObject({localLap:null,access:null,error:{code:"stale_state"}});
  });
  test("authoritative original GUID mismatch is rejected without navigation",async()=>{
    const controller=createCloudLapImportController({...allowCommunity,getAccessToken:async()=>"token",importLap:async input=>{input.onIdentity({...selection,lapGuid:"018f0000-0000-7000-8000-000000000099"});return lap;}});
    await start(controller,"mismatch");
    for(let turn=0;turn<10;turn++)await Promise.resolve();
    expect(await state(controller)).toMatchObject({status:"error",localLap:null,error:{code:"lap_identity_conflict",retryable:false}});
  });
});
