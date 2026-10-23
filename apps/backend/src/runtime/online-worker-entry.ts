import { parentPort,workerData } from "node:worker_threads";
import { createCloudLapImporter,CloudLapImportError,validateCloudLapImportUrl } from "@raceiq/backend-core/session-capture/cloud-lap-import";
import { initDbWorkerConnection,closeDb } from "@raceiq/backend-core/db/index";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { claimLocalAccountOwner,getLocalAccountOwner,getLocalGameBindingSnapshot,upsertLocalGameBinding } from "@raceiq/backend-core/db/local-account-queries";
import { getOnlineUploadCandidatePage,type OnlineUploadCandidateCursor } from "@raceiq/backend-core/db/online-upload-queries";
import { createOnlineRecordingProducer } from "@raceiq/backend-core/session-capture/online-recording-producer";
import { buildLocalDriverSummary,getLocalDriverSummaryHolds,prepareDriverSummaryContributions,listReadyDriverSummaryContributionPage,recordDriverSummaryReceipt,recordDriverSummaryHold,hasPendingDriverSummaryPreparations,isDriverSummaryContributionCurrent } from "@raceiq/backend-core/driver-summary/index";
import { validateNativeDriverBinding } from "@raceiq/backend-core/lap-detection/native-attribution";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { hydrateDiscoveredAcEvoCars,listDiscoveredCars } from "@raceiq/backend-core/db/discovered-cars";
import { hydrateDiscoveredAcEvoTracks,listDiscoveredTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { injectDiscoveredIRacingIdentity } from "@raceiq/game-iracing-metadata/index";
import { injectDiscoveredLMUIdentity } from "@raceiq/game-lmu-metadata/index";
import { configureOnlineRuntime } from "@raceiq/online/server/runtime";
import { createRaceIqOnlineService,type RaceIqOnlineService } from "@raceiq/online/server/service";
import { startOnlineUploadCoordinator } from "@raceiq/online/server/coordinator";
import { startOnlineProfileCoordinator } from "@raceiq/online/server/profile-coordinator";
import { enqueueOutboxJob,listAcceptedOutboxJobs,recordOutboxRemoteStatus,closeOutboxStorage,ensureOutboxStorage } from "@raceiq/online/server/outbox-storage";
import { closeProfileStorage,ensureProfileStorage } from "@raceiq/online/server/profile-storage";
import { getRegisteredOnlineBinding,retainRegisteredOnlineBinding,hasLocalBindingConfirmation,closeBindingStorage,ensureBindingStorage } from "@raceiq/online/server/binding-storage";
import { notifyOnlineSync } from "@raceiq/online/server/sync-events";
import type { OnlineKeystore,OnlineError } from "@raceiq/online/contracts";
import { getOnlineRecordingError,type PreparedOnlineLapUpload } from "@raceiq/online/server/payload";
import type { OnlineUploadContext } from "@raceiq/online/server/upload-dispatch";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";
import { initServerGameAdapters } from "../games/init";
import { createOnlineLocalPort } from "@raceiq/online/server/local";
import { createOnlineProfileSync } from "@raceiq/online/server/profile-sync";
import { createCloudLapImportController } from "@raceiq/online/server/cloud-lap-import-controller";
import { createNativeBoardIdentifierResolver } from "@raceiq/online/server/identifiers";
import { readOnlineTestPlatform,createOnlineTestFetch } from "../integrations/online-test-platform";
import type { WorkerRequest,WorkerResponse,HostResponse,HostRequest,OnlineHostPort,HostMethod,NativeBindingsChanged } from "@raceiq/online/server/worker-protocol";
import { configureDatabaseWriteWorkerTransport, type WriteLeaseRequest, type WriteLeaseResponse } from "@raceiq/backend-core/db/write-coordination";

const host=parentPort;
if(!host) throw new Error("Online worker requires a host");
const initialControl:unknown=workerData;
if(!initialControl||typeof initialControl!=="object"||!("nativeSourceRevisionBuffer"in initialControl)||
  !(initialControl.nativeSourceRevisionBuffer instanceof SharedArrayBuffer)||initialControl.nativeSourceRevisionBuffer.byteLength!==Uint32Array.BYTES_PER_ELEMENT)throw new Error("Native control unavailable");
const nativeRevisions=new Uint32Array(initialControl.nativeSourceRevisionBuffer);
const leaseListeners = new Set<(message: WriteLeaseResponse) => void>();
const disconnectLeaseTransport = configureDatabaseWriteWorkerTransport({
  request: (message: WriteLeaseRequest) => host.postMessage(message),
  subscribe(listener) { leaseListeners.add(listener); return () => { leaseListeners.delete(listener); }; },
});
host.on("message", (message: { type: string }) => {
  if (message.type.startsWith("write-lease-")) for (const listener of leaseListeners) listener(message as WriteLeaseResponse);
});
const hostPending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
host.on("close", () => {
  for (const listener of leaseListeners) listener({ type: "write-lease-channel-closed", reason: "Online worker lease channel closed" });
  disconnectLeaseTransport();
  for (const pending of hostPending.values()) { clearTimeout(pending.timer); pending.reject(new Error("host_unavailable")); }
  hostPending.clear();
});
function hostRequest<K extends HostMethod>(method:K,...args:Parameters<OnlineHostPort[K]>):ReturnType<OnlineHostPort[K]> {
  const {promise,resolve,reject}=Promise.withResolvers<unknown>();
  const requestId=crypto.randomUUID();
  const timer=setTimeout(()=>{hostPending.delete(requestId);reject(new Error("host_unavailable"));},15_000);
  hostPending.set(requestId,{resolve,reject,timer});
  host!.postMessage({type:"host",requestId,method,args} as HostRequest);
  return promise as ReturnType<OnlineHostPort[K]>;
}
const keystore:OnlineKeystore={
  getSecret:key=>hostRequest("getSecret",key),
  setSecret:(key,value)=>hostRequest("setSecret",key,value),
};
const testPlatform=readOnlineTestPlatform();
configureOnlineRuntime({resolveDataDir});
await initDbWorkerConnection();
await Promise.all([ensureOutboxStorage(),ensureProfileStorage(),ensureBindingStorage()]);
initGameAdapters(serverReleaseFeatures);
initServerGameAdapters(serverReleaseFeatures);
async function refreshDiscoveredMetadata(){
  await hydrateDiscoveredAcEvoCars();
  await hydrateDiscoveredAcEvoTracks();
  const [iracingCars,iracingTracks,lmuCars,lmuTracks]=await Promise.all([listDiscoveredCars("iracing"),listDiscoveredTracks("iracing"),listDiscoveredCars("lmu"),listDiscoveredTracks("lmu")]);
  injectDiscoveredIRacingIdentity(iracingCars,iracingTracks);
  injectDiscoveredLMUIdentity(lmuCars,lmuTracks);
}
await refreshDiscoveredMetadata();
const recordingProducer=createOnlineRecordingProducer({async resolveDriverBinding(captured){
  const uploadContext=await service.getUploadContext();
  const context=await service.getProfileSyncContext();
  if(!context||!uploadContext||await getLocalAccountOwner()!==context.accountId||!service.isUploadContextCurrent(uploadContext))throw Object.assign(new Error("not_connected"),{code:"not_connected"});
  if(!validateNativeDriverBinding(captured)||!await hasLocalBindingConfirmation(captured))throw Object.assign(new Error("driver_identity_required"),{code:"driver_identity_required"});
  const existing=await getRegisteredOnlineBinding(context.accountId,captured);
  if(existing)return existing;
  if(!service.isProfileSyncContextCurrent(context))throw Object.assign(new Error("stale_state"),{code:"stale_state"});
  const remote=await service.registerGameBinding(captured,true,context,()=>service.isUploadContextCurrent(uploadContext));
  await retainRegisteredOnlineBinding(context.accountId,captured,remote);
  return remote;
}});
const service:RaceIqOnlineService=createRaceIqOnlineService({keystore,recordingProducer,
  ...(testPlatform?{...testPlatform,fetch:createOnlineTestFetch(testPlatform)}:{}),
  async onAccountConnected(userId,isCurrent){await claimLocalAccountOwner(userId,{isCurrent});},
});
let nativeSourceRevision=Atomics.load(nativeRevisions,0);
let profilePreparation:"preparing"|"ready"|"unavailable"="preparing";
function acceptNativeRevision(revision:number){
  if(revision!==nativeSourceRevision&&revision===Atomics.load(nativeRevisions,0)){nativeSourceRevision=revision;service.invalidateSourceBindings();}
}
const local=createOnlineLocalPort(service,{
  async listCandidates(){const snapshot=await hostRequest("listDriverBindingCandidates");acceptNativeRevision(snapshot.sourceRevision);return snapshot;},
  async resolveCandidate(candidateId,expectedBindingRevision){
    const proof=await hostRequest("resolveDriverBindingCandidate",candidateId,expectedBindingRevision);
    if(proof)acceptNativeRevision(proof.sourceRevision);
    return proof;
  },
  isCurrent:proof=>proof.sourceRevision===Atomics.load(nativeRevisions,0)&&Number.isFinite(Date.parse(proof.expiresAt))&&Date.parse(proof.expiresAt)>Date.now(),
  consumeCandidate:proof=>hostRequest("consumeDriverBindingCandidate",proof.candidateId,proof.sourceRevision),
},()=>profilePreparation,{
  getLocalAccountOwner,
  getLocalGameBindingSnapshot,
  upsertLocalGameBinding,
  validateNativeDriverBinding,
  getLocalDriverSummaryHolds,
});
let importContext:OnlineUploadContext|null=null;
const importFetch=testPlatform?createOnlineTestFetch(testPlatform):globalThis.fetch;
const imports=createCloudLapImportController({
  getAccessToken:()=>service.getImportAccessToken(),
  async getCommunityEntitlement(){
    const entitlement=await service.getCommunityEntitlement();
    importContext=entitlement.allowed?await service.getUploadContext():null;
    return entitlement;
  },
  isCommunityEntitlementCurrent:entitlement=>service.isCommunityEntitlementCurrent(entitlement),
  isCommunityEntitlementCurrentSync:entitlement=>importContext!==null&&importContext.accountEpoch===entitlement.accountEpoch
    &&importContext.revision===entitlement.onlineRevision&&service.isUploadContextCurrent(importContext),
  identifiers:createNativeBoardIdentifierResolver(),
  validateUrl:validateCloudLapImportUrl,
  createError(code,retryable){
    switch(code){
      case "auth_required":case "lap_identity_conflict":case "invalid_manifest":case "import_busy":case "invalid_url":
        return new CloudLapImportError(code,retryable);
      default: return new CloudLapImportError("download_failed",true);
    }
  },
  readFailure(cause){return cause instanceof CloudLapImportError?{code:cause.code,retryable:cause.retryable}:null;},
  createImporter(fetch){
    return createCloudLapImporter({...(testPlatform?{origin:testPlatform.baseUrl}:{}),fetch:Object.assign((input:RequestInfo|URL,init?:RequestInit)=>fetch(input,init),{preconnect:importFetch.preconnect})});
  },
  fetch:importFetch,
});
let stopping=false;
let candidatePreparation:{context:OnlineUploadContext;error:OnlineError}|null=null;
const uploads=startOnlineUploadCoordinator({...service,
  async scan(context){
    let cursor:OnlineUploadCandidateCursor|null=null,boardKey:string|null=null,selected=false;
    let boardFailure:OnlineError|null=null,failure:OnlineError|null=null;
    try{
      await refreshDiscoveredMetadata();
      while(!stopping&&service.isUploadContextCurrent(context)){
        const page=await getOnlineUploadCandidatePage(cursor);
        for(const row of page.items){
          await Bun.sleep(0);
          if(stopping||!service.isUploadContextCurrent(context))return;
          const key=JSON.stringify([row.gameId,row.trackId,row.carId]);
          if(key!==boardKey){if(!selected)failure??=boardFailure;boardKey=key;selected=false;boardFailure=null;}
          if(selected)continue;
          let prepared:PreparedOnlineLapUpload;
          try{prepared=await recordingProducer(row.lapId,context.setupUploads);}
          catch(cause){boardFailure??=getOnlineRecordingError(cause);continue;}
          if(stopping||!service.isUploadContextCurrent(context))return;
          if(prepared.ownerUserId!==context.accountId||row.ownerUserId!==context.accountId){boardFailure??={code:"activity_owner_conflict",retryable:false,retryAfter:null};continue;}
          if(prepared.lapId!==row.lapId||prepared.gameId!==row.gameId||prepared.trackId!==row.trackId||prepared.carId!==row.carId||prepared.lapTimeMs!==row.lapTimeMs||prepared.lapGuid!==row.lapGuid||prepared.originalActivityId!==row.originalActivityId){boardFailure??={code:"lap_identity_conflict",retryable:false,retryAfter:null};continue;}
          const {lapGuid,originalActivityId,sourceRevision,sourceKind,ownerUserId,driverBindingId,driverBindingRevision}=prepared;
          const admitted=await enqueueOutboxJob({accountId:context.accountId,accountEpoch:context.accountEpoch,lapId:row.lapId,lapTimeMs:row.lapTimeMs,gameId:row.gameId,trackId:row.trackId,carId:row.carId,
            identity:{lapGuid,originalActivityId,sourceRevision,sourceKind,ownerUserId,driverBindingId,driverBindingRevision}});
          if(admitted==="full"){failure??={code:"service_unavailable",retryable:true,retryAfter:null};return;}
          if(admitted==="rejected"){boardFailure??={code:"validation_rejected",retryable:false,retryAfter:null};continue;}
          selected=true;
        }
        if(!page.nextCursor)break;
        cursor=page.nextCursor;
      }
      if(!selected)failure??=boardFailure;
    }catch(cause){failure??=getOnlineRecordingError(cause);throw cause;}
    finally{if(service.isUploadContextCurrent(context))candidatePreparation=failure?{context,error:failure}:null;}
  },
  async afterDelivery(){await readbackUploads();},
});
const profilePort=createOnlineProfileSync(service,{
  getLocalAccountOwner,
  prepareDriverSummaryContributions,
  listReadyDriverSummaryContributionPage,
  recordDriverSummaryReceipt,
  recordDriverSummaryHold,
  hasPendingDriverSummaryPreparations,
  isDriverSummaryContributionCurrent,
});
const profiles=startOnlineProfileCoordinator({...profilePort,async prepare(context,hash){
  profilePreparation="preparing";
  try{await readbackUploads();}catch{console.error("[OnlineUpload] Remote status storage unavailable");}
  try{const more=await profilePort.prepare(context,hash);profilePreparation=more||!service.isProfileSyncContextCurrent(context)?"preparing":"ready";return more;}
  catch(cause){profilePreparation="unavailable";throw cause;}
}});
async function readbackUploads():Promise<void>{
  const context=await service.getProfileSyncContext();
  if(!context||stopping)return;
  for(const job of await listAcceptedOutboxJobs(context.accountId)){
    if(!job.remoteJobId||!service.isProfileSyncContextCurrent(context)||stopping)return;
    try{
      const remote=await service.getLapJob(job.remoteJobId,context);
      if(!service.isProfileSyncContextCurrent(context))return;
      const status=remote.status;
      await recordOutboxRemoteStatus(job,status==="completed"?"validated":status==="failed"?"rejected":"pending",
        remote.publicationStatus==="unpublished"?"withdrawn":status==="failed"?"failed":status!=="completed"?"pending":remote.publicationStatus==="public"?"public":"not_requested");
    }catch{await recordOutboxRemoteStatus(job,"unavailable","unavailable");}
    await Bun.sleep(0);
  }
}
let stopPromise:Promise<void>|null=null;
const inFlight = new Set<Promise<void>>();
function stop():Promise<void>{
  stopPromise??=(async()=>{
    stopping=true;service.stopAdmission();notifyOnlineSync();
    const coordinators = await Promise.allSettled([uploads.stop(),profiles.stop(),imports.stop(),...inFlight]);
    const storage = await Promise.allSettled([closeOutboxStorage(),closeProfileStorage(),closeBindingStorage()]);
    try { closeDb(); }
    finally { disconnectLeaseTransport(); }
    const failures = [...coordinators,...storage].filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Online worker shutdown failed");
  })();
  return stopPromise;
}
host.on("close", () => { void stop().catch(cause => console.error("[OnlineWorker] Shutdown failed:", cause)); });
async function dispatch(request:WorkerRequest):Promise<unknown>{
  if(stopping&&request.method!=="stop")throw new Error("service_unavailable");
  switch(request.method){
    case "getState":{
      const state=await service.getState(...request.args);
      if(candidatePreparation&&service.isUploadContextCurrent(candidatePreparation.context))state.sync.lastError??=candidatePreparation.error;
      return state;
    }
    case "connect":return service.connect(...request.args);
    case "cancelSignIn":return service.cancelSignIn(...request.args);
    case "acceptConsent":return service.acceptConsent(...request.args);
    case "setPreferences":return service.setPreferences(...request.args);
    case "setDisplayName":return service.setDisplayName(...request.args);
    case "signOut":return service.signOut(...request.args);
    case "getLeaderboard":await refreshDiscoveredMetadata();return service.getLeaderboard(...request.args);
    case "handleAuthCallback":return service.handleAuthCallback(...request.args);
    case "getCommunityEntitlement":return service.getCommunityEntitlement(...request.args);
    case "isCommunityEntitlementCurrent":return service.isCommunityEntitlementCurrent(...request.args);
    case "getDriverBindings":return local.getDriverBindings(...request.args);
    case "setDriverBinding":return local.setDriverBinding(...request.args);
    case "getUploads":return local.getUploads(...request.args);
    case "getOnlineProfile":return local.getOnlineProfile(...request.args);
    case "getLocalSummary":return buildLocalDriverSummary(...request.args);
    case "dispatchCloudLapImport":return imports.dispatchCloudLapImport(...request.args);
    case "importRequest":{
      const [input]=request.args;
      if(!["/api/online/lap-import","/api/online/lap-import/retry","/api/online/lap-import/ack"].includes(input.path)||(input.body?.length??0)>8192||(input.query?.length??0)>2048)throw new Error("invalid_request");
      if(input.method==="POST"&&input.path==="/api/online/lap-import")await refreshDiscoveredMetadata();
      const response=await imports.routes.request(`http://localhost${input.path}${input.query?`?${input.query}`:""}`,{method:input.method,headers:{"Content-Type":"application/json",...(input.gameId?{"X-Game-Id":input.gameId}:{})},body:input.body});
      return {status:response.status,body:await response.json() as CloudLapImportState};
    }
    case "wake":profilePreparation="preparing";notifyOnlineSync();return;
    case "stop":return stop();
    default:{const exhaustive:never=request;throw new Error(String(exhaustive));}
  }
}
host.on("message",(message:WorkerRequest|HostResponse|NativeBindingsChanged)=>{
  if(message.type==="native-bindings-changed"){
    acceptNativeRevision(message.sourceRevision);
    return;
  }
  if(message.type==="host-response"){
    const pending=hostPending.get(message.requestId);if(!pending)return;
    hostPending.delete(message.requestId);clearTimeout(pending.timer);
    if(message.ok)pending.resolve(message.value);else pending.reject(new Error("keystore_unavailable"));
    return;
  }
  if(message.type!=="request")return;
  const response = dispatch(message).then(value=>{
    host.postMessage({type:"response",requestId:message.requestId,ok:true,value} satisfies WorkerResponse);
    if(message.method==="stop")host.close();
  },cause=>{
    const code=cause instanceof Error&&"code"in cause&&cause.code==="building"?"building":cause instanceof Error&&"code"in cause&&cause.code==="stale_state"?"stale_state":"service_unavailable";
    const error:Extract<WorkerResponse,{ok:false}>["error"]=code==="building"?{code:"building",retryable:true,retryAfter:null}:{code,retryable:code!=="stale_state",retryAfter:null};
    host.postMessage({type:"response",requestId:message.requestId,ok:false,error,status:code==="building"?202:code==="stale_state"?409:503} satisfies WorkerResponse);
    if(message.method==="stop")host.close();
  });
  if (message.method !== "stop") inFlight.add(response);
  void response.then(() => { inFlight.delete(response); }, cause => {
    inFlight.delete(response);
    console.error("[OnlineWorker] Response channel failed:", cause);
  });
});
for(const handle of [uploads,profiles])void handle.completion.catch(()=>{
  if(!stopping){service.stopAdmission();host.postMessage({type:"fatal"});}
});
await Promise.all([uploads.ready,profiles.ready]);
host.postMessage({type:"ready"});
