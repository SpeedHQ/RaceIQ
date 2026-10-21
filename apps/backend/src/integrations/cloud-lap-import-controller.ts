import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { CommunityEntitlement } from "@raceiq/online/contracts";
import { createCloudLapImporter,importCloudLap,CloudLapImportError,validateCloudLapImportUrl } from "@raceiq/backend-core/session-capture/cloud-lap-import";
import { IDLE_CLOUD_LAP_IMPORT,type CloudLapImportState,type CloudLapImportAccessContext,type CloudLapImportSelection } from "@raceiq/shared/integrations/cloud-lap-import";
import { createNativeBoardIdentifierResolver } from "@raceiq/online/identifiers";

import { cloudImportStart,cloudImportQuery,cloudImportActivation } from "./online-import-contract";
import { readOnlineTestPlatform, createOnlineTestFetch } from "./online-test-platform";
type AllowedCommunity=Extract<CommunityEntitlement,{allowed:true}>;
type Selection=CloudLapImportSelection&{lapGuid:string};
export interface CloudLapImportControllerOptions {
  getAccessToken:()=>Promise<string|null>;
  getCommunityEntitlement:()=>Promise<CommunityEntitlement>;
  isCommunityEntitlementCurrent:(entitlement:AllowedCommunity)=>Promise<boolean>;
  isCommunityEntitlementCurrentSync:(entitlement:AllowedCommunity)=>boolean;
  importLap?:typeof importCloudLap;
}

export function createCloudLapImportController(options:CloudLapImportControllerOptions) {
  const idle=IDLE_CLOUD_LAP_IMPORT;
  let state:CloudLapImportState=idle;
  type Intent={lapId:string;sourceUrl:string|null;activationId:number;entitlement:AllowedCommunity;selection:Selection|null;lapGuidHint:string|null;identityValidated:boolean};
  const pending:Intent[]=[];
  let running:Promise<void>|null=null;
  let nextActivationId=Date.now();
  let completed:Intent|null=null;
  let active:Intent|null=null;
  const identifiers=createNativeBoardIdentifierResolver();
  const testPlatform=readOnlineTestPlatform();
  const fetcher=testPlatform?createOnlineTestFetch(testPlatform):globalThis.fetch;
  const importLap=options.importLap??createCloudLapImporter({...(testPlatform?{origin:testPlatform.baseUrl}:{}),fetch:Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(!active||!await current(active.entitlement))throw new CloudLapImportError("auth_required",true);
    return fetcher(input,init);
  },{preconnect:fetcher.preconnect})});
  const access=(entitlement:AllowedCommunity):CloudLapImportAccessContext=>({accountEpoch:entitlement.accountEpoch,expectedRevision:entitlement.onlineRevision});
  const matches=(a:CloudLapImportAccessContext,b:AllowedCommunity)=>a.accountEpoch===b.accountEpoch&&a.expectedRevision===b.onlineRevision;
  const denied=(code:string,retryable=false):CloudLapImportState=>({...idle,status:"error",error:{code,retryable}});
  const snapshot=(intent:Intent,status:CloudLapImportState["status"],localLap:CloudLapImportState["localLap"]=null,error:CloudLapImportState["error"]=null):CloudLapImportState=>({
    status,lapId:intent.lapId,activationId:intent.activationId,localLap,error,access:access(intent.entitlement),lapGuid:intent.selection?.lapGuid??null,
    selection:intent.selection?{gameId:intent.selection.gameId,trackId:intent.selection.trackId,carId:intent.selection.carId}:null,
  });
  async function current(entitlement:AllowedCommunity):Promise<boolean>{try{return await options.isCommunityEntitlementCurrent(entitlement);}catch{return false;}}
  async function authorize(request?:CloudLapImportAccessContext):Promise<AllowedCommunity|CloudLapImportState>{
    let entitlement:CommunityEntitlement;
    try{entitlement=await options.getCommunityEntitlement();}catch{return denied("service_unavailable",true);}
    if(!entitlement.allowed){pending.length=0;completed=null;state=denied(entitlement.error.code,entitlement.error.retryable);return state;}
    if(request&&!matches(request,entitlement))return denied("stale_state");
    return entitlement;
  }
  const isAllowed=(value:AllowedCommunity|CloudLapImportState):value is AllowedCommunity=>"allowed"in value;
  function remove(intent:Intent){const index=pending.indexOf(intent);if(index>=0)pending.splice(index,1);}
  async function runImport():Promise<void>{
    if(running||completed||pending.length===0)return;
    const intent=pending[0]!;
    running=(async()=>{
      try{
        if(!await current(intent.entitlement)){remove(intent);return;}
        const token=await options.getAccessToken();
        if(!token||!await current(intent.entitlement)){remove(intent);return;}
        active=intent;intent.identityValidated=false;state=snapshot(intent,"downloading");
        const result=await importLap({lapId:intent.lapId,sourceUrl:intent.sourceUrl,accessToken:token,
          expectedSelection:intent.selection,
          async assertAuthorized(){if(!await current(intent.entitlement))throw new CloudLapImportError("auth_required",true);},
          isAuthorized:()=>options.isCommunityEntitlementCurrentSync(intent.entitlement),
          onIdentity(identity){
            if(intent.lapGuidHint&&identity.lapGuid!==intent.lapGuidHint)throw new CloudLapImportError("lap_identity_conflict",false);
            if(intent.selection&&(identity.lapGuid!==intent.selection.lapGuid||identity.gameId!==intent.selection.gameId||identity.trackId!==intent.selection.trackId||identity.carId!==intent.selection.carId))throw new CloudLapImportError("lap_identity_conflict",false);
            intent.selection=identity;
            intent.identityValidated=true;
          },
          onState(status){if(pending[0]===intent)state=snapshot(intent,status);},
        });
        if(!await current(intent.entitlement)){remove(intent);return;}
        if(!intent.selection||!intent.identityValidated)throw new CloudLapImportError("invalid_manifest",false);
        state=snapshot(intent,"complete",result);completed=intent;remove(intent);
      }catch(cause){
        const error=cause instanceof CloudLapImportError?cause:new CloudLapImportError("download_failed",true);
        if(!await current(intent.entitlement)){remove(intent);return;}
        state=snapshot(intent,"error",null,{code:error.code,retryable:error.retryable});
        if(!error.retryable)remove(intent);
      }
    })().finally(()=>{if(active===intent)active=null;running=null;});
    await running;
  }
  function enqueue(lapId:string,sourceUrl:string|null,entitlement:AllowedCommunity,selection:Selection|null,lapGuidHint:string|null=null):CloudLapImportState{
    const existing=pending.find(intent=>intent.lapId===lapId&&intent.entitlement.accountEpoch===entitlement.accountEpoch&&intent.entitlement.onlineRevision===entitlement.onlineRevision);
    if(existing)return snapshot(existing,"awaiting_sign_in");
    if(pending.length>=32)throw new CloudLapImportError("import_busy",true);
    const intent:Intent={lapId,sourceUrl,entitlement,selection,lapGuidHint,identityValidated:false,activationId:nextActivationId++};
    pending.push(intent);
    if(!running&&!completed){state=snapshot(intent,"awaiting_sign_in");void runImport();}
    return snapshot(intent,"awaiting_sign_in");
  }
  async function dispatchCloudLapImport(value:string):Promise<CloudLapImportState>{
    const entitlement=await authorize();if(!isAllowed(entitlement))return entitlement;
    const url=new URL(value),entries=[...url.searchParams.entries()];
    if(url.protocol!=="raceiq:"||url.hostname!=="import"||url.port||(url.pathname!==""&&url.pathname!=="/")||url.username||url.password||url.hash||
      entries.some(([key])=>key!=="url"&&key!=="lapGuid")||entries.filter(([key])=>key==="url").length!==1||entries.filter(([key])=>key==="lapGuid").length>1)throw new CloudLapImportError("invalid_url",false);
    const sourceUrl=url.searchParams.get("url")!,lapId=validateCloudLapImportUrl(sourceUrl),hint=url.searchParams.get("lapGuid");
    if(hint!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hint))throw new CloudLapImportError("invalid_url",false);
    return enqueue(lapId,sourceUrl,entitlement,null,hint?.toLowerCase()??null);
  }
  const routes=new Hono()
    .get("/api/online/lap-import",zValidator("query",cloudImportQuery),async c=>{
      const entitlement=await authorize(c.req.valid("query"));if(!isAllowed(entitlement))return c.json(entitlement,entitlement.error?.code==="stale_state"?409:entitlement.error?.code==="not_connected"?401:403);
      if(state.access&&!matches(state.access,entitlement))return c.json(idle);
      if(completed&&!await current(completed.entitlement)){completed=null;return c.json(denied("sharing_required"),403);}
      return c.json(state);
    })
    .post("/api/online/lap-import",zValidator("json",cloudImportStart),async c=>{
      const input=c.req.valid("json"),entitlement=await authorize(input);if(!isAllowed(entitlement))return c.json(entitlement,entitlement.error?.code==="stale_state"?409:entitlement.error?.code==="not_connected"?401:403);
      const gameId=c.req.header("X-Game-Id");
      const board=gameId?identifiers.resolve({gameId,trackId:input.trackId,carId:input.carId}):null;
      if(!board||board.status!=="mapped")return c.json(denied("invalid_request"),400);
      return c.json(enqueue(input.lapId,null,entitlement,{...board.key,lapGuid:input.lapGuid.toLowerCase()}),202);
    })
    .post("/api/online/lap-import/retry",zValidator("json",cloudImportActivation),async c=>{
      const input=c.req.valid("json"),entitlement=await authorize(input);if(!isAllowed(entitlement))return c.json(entitlement,entitlement.error?.code==="stale_state"?409:entitlement.error?.code==="not_connected"?401:403);
      const intent=pending[0];
      if(!intent||intent.activationId!==input.activationId||!matches(input,intent.entitlement)||!await current(intent.entitlement))return c.json(denied("stale_state"),409);
      state=snapshot(intent,"awaiting_sign_in");void runImport();return c.json(state,202);
    })
    .post("/api/online/lap-import/ack",zValidator("json",cloudImportActivation),async c=>{
      const input=c.req.valid("json"),entitlement=await authorize(input);if(!isAllowed(entitlement))return c.json(entitlement,entitlement.error?.code==="stale_state"?409:entitlement.error?.code==="not_connected"?401:403);
      if(!completed||completed.activationId!==input.activationId||!matches(input,completed.entitlement)||!await current(completed.entitlement))return c.json(denied("stale_state"),409);
      completed=null;state=idle;
      if(pending.length)void runImport();
      return c.json(idle);
    });
  return {routes,dispatchCloudLapImport,async stop(){pending.length=0;completed=null;await running;}};
}
