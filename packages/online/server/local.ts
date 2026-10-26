import type { OnlineLocalPort,OnlineCommandResult,OnlineProfileResponse,UploadItem,GameIdentityBinding } from "../contracts/index";
import type { RaceIqOnlineService } from "./service";
import type { UploadPageBoundary } from "./upload-dispatch";
import { notifyOnlineSync } from "./sync-events";
import { recordLocalBindingConfirmation } from "./binding-storage";
import type { NativeBindingProof,NativeBindingCandidateSnapshot } from "./worker-protocol";
export interface TrustedNativeBindingsPort {
  listCandidates():Promise<NativeBindingCandidateSnapshot>;
  resolveCandidate(candidateId:string,expectedBindingRevision:number):Promise<NativeBindingProof|null>;
  isCurrent(proof:NativeBindingProof):boolean;
  consumeCandidate(proof:NativeBindingProof):Promise<void>;
}
export interface OnlineLocalPlatform {
  readLapUploadItems(accountId:string,view:"queue"|"history",boundary:UploadPageBoundary|null,limit:number):Promise<UploadItem[]>;
  getLocalAccountOwner(): Promise<string | null>;
  getLocalGameBindingSnapshot(): Promise<{ revision: number; bindings: GameIdentityBinding[] }>;
  upsertLocalGameBinding(binding: GameIdentityBinding, options: { expectedSnapshotRevision: number; isCurrent(): boolean }): Promise<void>;
  validateNativeDriverBinding(proof: NativeBindingProof): boolean;
}

export function createOnlineLocalPort(service:RaceIqOnlineService,trustedBindings:TrustedNativeBindingsPort,platform:OnlineLocalPlatform):OnlineLocalPort {
  return {
    async getDriverBindings(){
      const snapshot=await platform.getLocalGameBindingSnapshot(),native=await trustedBindings.listCandidates();
      return {...snapshot,candidates:native.candidates};
    },
    async setDriverBinding(input) {
      const failure=async(code:"invalid_request"|"stale_state"|"driver_identity_required"):Promise<OnlineCommandResult>=>({ok:false,error:{code,retryable:false,retryAfter:null},state:await service.getState()});
      if(input.confirmedByUser!==true)return failure("invalid_request");
      if(!service.isMutationContextCurrent(input))return failure("stale_state");
      const snapshot=await platform.getLocalGameBindingSnapshot();
      const proof=await trustedBindings.resolveCandidate(input.candidateId,snapshot.revision);
      if(!proof||!platform.validateNativeDriverBinding(proof))return failure("driver_identity_required");
      if(proof.bindingRevision!==snapshot.revision||!trustedBindings.isCurrent(proof))return failure("stale_state");
      const existing=snapshot.bindings.find(binding=>binding.gameId===proof.gameId);
      const binding:GameIdentityBinding={id:existing?.id??crypto.randomUUID(),gameId:proof.gameId,sourceKind:proof.sourceKind,
        nativeIdentity:proof.nativeIdentity,confirmation:"user_confirmed",revision:(existing?.revision??0)+1};
      const barrier=await service.invalidatePreparation(input);
      if(!barrier.ok)return barrier;
      const mutation={accountEpoch:barrier.state.accountEpoch,expectedRevision:barrier.state.revision};
      try{
        await platform.upsertLocalGameBinding(binding,{expectedSnapshotRevision:snapshot.revision,isCurrent:()=>trustedBindings.isCurrent(proof)&&service.isMutationContextCurrent(mutation)});
        await recordLocalBindingConfirmation(binding);
        await trustedBindings.consumeCandidate(proof);
      }catch(cause){
        if(cause instanceof Error&&"code"in cause&&cause.code==="stale_state")return failure("stale_state");
        throw cause;
      }
      notifyOnlineSync();
      return {ok:true,state:await service.getState()};
    },
    async getUploads(input) {
      const state=await service.getState();
      if(input.accountEpoch!==state.accountEpoch || input.expectedRevision!==state.revision) throw Object.assign(new Error("stale_state"),{code:"stale_state",status:409});
      if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100) throw Object.assign(new Error("invalid_request"),{code:"invalid_request",status:400});
      const owner=await platform.getLocalAccountOwner();
      let boundary:{time:number;id:string}|null=null;
      if(input.cursor) {
        try {
          const value:unknown=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"));
          if(!value||typeof value!=="object"||!("owner"in value)||value.owner!==owner||!("epoch"in value)||value.epoch!==state.accountEpoch||!("view"in value)||value.view!==input.view||!("time"in value)||typeof value.time!=="number"||!Number.isSafeInteger(value.time)||!("id"in value)||typeof value.id!=="string") throw new Error();
          boundary={time:value.time,id:value.id};
        } catch { throw Object.assign(new Error("invalid_request"),{code:"invalid_request",status:400}); }
      }
      const items:UploadItem[]=owner?await platform.readLapUploadItems(owner,input.view,boundary,input.limit+1):[];
      const time=(item:UploadItem)=>Date.parse(input.view==="history"?item.settledAt??item.updatedAt:item.admittedAt);
      items.sort((a,b)=>(time(a)-time(b)||a.id.localeCompare(b.id))*(input.view==="history"?-1:1));
      const more=items.length>input.limit;
      items.length=Math.min(items.length,input.limit);
      const last=items.at(-1);
      const current=await service.getState();
      if(current.accountEpoch!==state.accountEpoch||current.revision!==state.revision) throw Object.assign(new Error("stale_state"),{code:"stale_state",status:409});
      return {schemaVersion:2,accountEpoch:state.accountEpoch,items,nextCursor:more&&last?Buffer.from(JSON.stringify({owner,epoch:state.accountEpoch,view:input.view,time:time(last),id:last.id})).toString("base64url"):null,observedAt:new Date().toISOString(),stale:false};
    },
    async getOnlineProfile():Promise<OnlineProfileResponse> {
      const state=await service.getState();
      const base:OnlineProfileResponse={accountEpoch:state.accountEpoch,status:"unavailable",localPending:0,heldAmbiguous:0,lastConfirmedAt:null,onlineRevision:null,summary:null,
        coverage:{identity:"partial",driverAttribution:"partial",sessionDuration:"unavailable",distance:"unavailable"},legacyStats:null,error:null};
      if(state.connection.status!=="connected") return {...base,status:"signed_out"};
      if(state.consent.status!=="accepted") return {...base,status:"consent_required"};
      const context=await service.getAccountContext();
      if(!context) return {...base,error:{code:"service_unavailable",retryable:true,retryAfter:null}};
      try {
        const remote=await service.readOwnerStats(context);
        if(!service.isAccountContextCurrent(context)) throw Object.assign(new Error("stale_state"),{code:"stale_state",status:409});
        if(!remote) return {...base,status:"unavailable"};
        const legacyStats=remote.legacyStats?{...remote.legacyStats,favoriteCar:remote.legacyStats.favoriteCar??null,favoriteGame:remote.legacyStats.favoriteGame??null}:null;
        if(remote.status==="legacy_unverified")return {...base,status:"legacy_unverified",coverage:remote.coverage,legacyStats};
        const summary=remote.summary?{metrics:{...remote.summary.metrics,distanceMeters:remote.summary.metrics.distanceMeters??null},
          games:remote.summary.games.map(game=>({...game,metrics:{...game.metrics,distanceMeters:game.metrics.distanceMeters??null},
            favoriteCar:game.favoriteCar??null,favoriteTrack:game.favoriteTrack??null}))}:null;
        return {...base,status:"ready",onlineRevision:remote.onlineRevision??null,summary,coverage:remote.coverage,legacyStats};
      } catch(cause) {
        if(cause instanceof Error&&"code"in cause&&cause.code==="stale_state") throw cause;
        return {...base,error:{code:"service_unavailable",retryable:true,retryAfter:null}};
      }
    },
  };
}
