import { OnlineAdapterError, type ReserveLapUploadInput, type ReserveLapUploadResult, type SanitizedLapUpload } from "./adapter";
import { getOnlineRecordingError, UPLOAD_GAME_IDS, type PreparedOnlineLapUpload } from "./payload";
import type { OnlineError } from "../contracts/index";

export interface OnlineUploadContext { accountId: string; accountEpoch: string; revision: number; setupUploads: boolean }
export interface OnlineUploadDispatchPort {
  getContext(): Promise<OnlineUploadContext | null>;
  isAuthorized(context: OnlineUploadContext, includesSetup: boolean): boolean;
  reserveLapUpload(input: Omit<ReserveLapUploadInput, "isAuthorized">, context: OnlineUploadContext, mayStart: () => boolean): Promise<ReserveLapUploadResult>;
  uploadLap(input: Omit<SanitizedLapUpload, "isAuthorized">, context: OnlineUploadContext, mayStart: () => boolean): Promise<{ id: string } | { acceptedJobId: string }>;
  prepareRecording(lapId: number, setupUploads: boolean): Promise<PreparedOnlineLapUpload>;
}
export type OnlineUploadRow = { lapId:number;gameId:string;trackId:string;carId:string;lapTimeMs:number;accountId:string;originalActivityId:string;lapGuid:string;result:string|null;idempotencyKey:string|null;identityJson:string|null;payloadFingerprint:string|null;reservationToken:string|null;remoteJobId:string|null;uploadedAt:string|null;retryAfter:string|null };
export type OnlineUploadStorage = { getOnlineUploadWinnerPage:(cursor:number|null,limit:number)=>Promise<{items:Array<{lapId:number;gameId:string;trackId:string;carId:string;lapTimeMs:number}>;nextCursor:number|null}>;readOnlineLapUpload:(lapId:number)=>Promise<OnlineUploadRow|null>;retainOnlineLapRequest:(lapId:number,request:{accountId:string;idempotencyKey:string;identityJson:string;payloadFingerprint:string;reservationToken?:string|null})=>Promise<boolean>;settleOnlineLapUpload:(lapId:number,key:string,result:string,remoteJobId:string|null,uploadedAt:string|null)=>Promise<boolean>;setOnlineLapRetryAfter:(lapId:number,key:string,retryAfter:string|null)=>Promise<boolean> };
export type OnlineUploadAttemptResult = { status:"success"|"rejected"|"skipped"|"retry";error:OnlineError|null };
export type UploadPageBoundary = { time:number;id:string };

function sameLap(left:OnlineUploadRow|null,right:OnlineUploadRow):boolean{
  return !!left&&left.lapId===right.lapId&&left.gameId===right.gameId&&left.trackId===right.trackId&&left.carId===right.carId&&left.lapTimeMs===right.lapTimeMs&&left.accountId===right.accountId&&left.lapGuid===right.lapGuid&&left.originalActivityId===right.originalActivityId&&left.result===null;
}
export function createOnlineUploadDispatcher(port:OnlineUploadDispatchPort,storage:OnlineUploadStorage):(lapId:number,mayStart?:()=>boolean)=>Promise<OnlineUploadAttemptResult>{
  return async(lapId,mayStart=()=>true)=>{
    const skipped:OnlineUploadAttemptResult={status:"skipped",error:null};
    const context=await port.getContext();
    if(!context||!mayStart())return skipped;
    let row=await storage.readOnlineLapUpload(lapId);
    const current=(includesSetup=false)=>mayStart()&&port.isAuthorized(context,includesSetup);
    if(!row||row.accountId!==context.accountId||row.result!==null||row.retryAfter&&Date.parse(row.retryAfter)>Date.now()||!current())return skipped;
    const key=row.idempotencyKey??Bun.randomUUIDv7();
    if(row.idempotencyKey){
      let identity:Partial<PreparedOnlineLapUpload>|null;
      try{identity=JSON.parse(row.identityJson??"null") as Partial<PreparedOnlineLapUpload>|null;}catch{return skipped;}
      if(!identity||identity.ownerUserId!==row.accountId||identity.lapGuid!==row.lapGuid||identity.originalActivityId!==row.originalActivityId||typeof identity.sourceRevision!=="string"||!identity.sourceRevision||!(identity.sourceKind==="native_capture"||identity.sourceKind==="verified_portable")||typeof identity.driverBindingId!=="string"||!identity.driverBindingId||typeof identity.driverBindingRevision!=="number"||!Number.isSafeInteger(identity.driverBindingRevision)||identity.driverBindingRevision<1)return skipped;
      if(!UPLOAD_GAME_IDS.includes(row.gameId as typeof UPLOAD_GAME_IDS[number])||(row.gameId==="f1-2025"&&row.carId!=="41"))return skipped;
      try{
        const requestRow=row;
        const accepted=await port.reserveLapUpload({lapGuid:row.lapGuid,originalActivityId:row.originalActivityId,ownerUserId:row.accountId,sourceRevision:identity.sourceRevision,sourceKind:identity.sourceKind,driverBindingId:identity.driverBindingId,driverBindingRevision:identity.driverBindingRevision,gameId:row.gameId as typeof UPLOAD_GAME_IDS[number],idempotencyKey:key,consentAccepted:true,visibility:"public",isCurrent:async()=>current()&&sameLap(await storage.readOnlineLapUpload(lapId),requestRow)},context,mayStart);
        if(accepted.acceptedJobId)return await storage.settleOnlineLapUpload(lapId,key,"success",accepted.acceptedJobId,new Date().toISOString())?{status:"success",error:null}:skipped;
        if(accepted.reservationToken){
          if(!await storage.retainOnlineLapRequest(lapId,{accountId:context.accountId,idempotencyKey:key,identityJson:row.identityJson??"",payloadFingerprint:row.payloadFingerprint??"",reservationToken:accepted.reservationToken}))return skipped;
          row=await storage.readOnlineLapUpload(lapId);
          if(!row||row.idempotencyKey!==key)return skipped;
        }
      }catch(cause){return await recordFailure(cause,storage,lapId,key);}
    }
    let prepared:PreparedOnlineLapUpload;
    try{prepared=await port.prepareRecording(lapId,context.setupUploads);}catch(cause){return await recordFailure(cause,storage,lapId,key);}
    if(!await prepared.isSourceCurrent()||!current(prepared.setup!==null))return skipped;
    const identity={lapGuid:prepared.lapGuid,originalActivityId:prepared.originalActivityId,sourceRevision:prepared.sourceRevision,sourceKind:prepared.sourceKind,ownerUserId:prepared.ownerUserId,driverBindingId:prepared.driverBindingId,driverBindingRevision:prepared.driverBindingRevision};
    const identityJson=JSON.stringify(identity);
    if(prepared.lapId!==row.lapId||prepared.gameId!==row.gameId||prepared.trackId!==row.trackId||prepared.carId!==row.carId||prepared.lapTimeMs!==row.lapTimeMs||prepared.ownerUserId!==row.accountId||prepared.lapGuid!==row.lapGuid||prepared.originalActivityId!==row.originalActivityId)return skipped;
    if(row.idempotencyKey&&(row.identityJson!==identityJson||row.payloadFingerprint!==prepared.fingerprint))return skipped;
    if(!row.idempotencyKey){
      if(!await storage.retainOnlineLapRequest(lapId,{accountId:context.accountId,idempotencyKey:key,identityJson,payloadFingerprint:prepared.fingerprint}))return skipped;
      row=await storage.readOnlineLapUpload(lapId);
      if(!row||row.idempotencyKey!==key||row.identityJson!==identityJson||row.payloadFingerprint!==prepared.fingerprint)return skipped;
    }
    try{
      if(!current(prepared.setup!==null)||!await prepared.isSourceCurrent()||!sameLap(await storage.readOnlineLapUpload(lapId),row))return skipped;
      let token=row.reservationToken;
      if(!token){
        const requestRow=row;
        const reservation=await port.reserveLapUpload({...identity,gameId:prepared.gameId,idempotencyKey:key,consentAccepted:true,visibility:"public",isCurrent:async()=>current(prepared.setup!==null)&&await prepared.isSourceCurrent()&&sameLap(await storage.readOnlineLapUpload(lapId),requestRow)},context,mayStart);
        if(reservation.acceptedJobId)return await storage.settleOnlineLapUpload(lapId,key,"success",reservation.acceptedJobId,new Date().toISOString())?{status:"success",error:null}:skipped;
        token=reservation.reservationToken;
        if(!token||!await storage.retainOnlineLapRequest(lapId,{accountId:context.accountId,idempotencyKey:key,identityJson,payloadFingerprint:prepared.fingerprint,reservationToken:token}))return skipped;
      }
      const latest=await storage.readOnlineLapUpload(lapId);
      if(!latest||latest.result!==null||latest.idempotencyKey!==key||latest.identityJson!==identityJson||latest.payloadFingerprint!==prepared.fingerprint||latest.reservationToken!==token||!current(prepared.setup!==null)||!await prepared.isSourceCurrent()||!sameLap(latest,row))return skipped;
      const requestRow=row;
      const isCurrent=async()=>current(prepared.setup!==null)&&await prepared.isSourceCurrent()&&sameLap(await storage.readOnlineLapUpload(lapId),requestRow);
      const receipt=await port.uploadLap({...identity,gameId:prepared.gameId,carId:prepared.carId,filename:prepared.filename,recording:prepared.recording,setup:prepared.setup??undefined,idempotencyKey:key,reservationToken:token,payloadFingerprint:prepared.fingerprint,consentAccepted:true,visibility:"public",setupUploads:context.setupUploads,codec:prepared.codec,isSourceCurrent:isCurrent},context,mayStart);
      const remote="acceptedJobId"in receipt?receipt.acceptedJobId:receipt.id;
      if(!remote)return {status:"retry",error:{code:"service_unavailable",retryable:true,retryAfter:null}};
      return await storage.settleOnlineLapUpload(lapId,key,"success",remote,new Date().toISOString())?{status:"success",error:null}:skipped;
    }catch(cause){if(cause instanceof OnlineAdapterError&&cause.code==="activity_revision_conflict")return skipped;if(cause instanceof OnlineAdapterError&&cause.code==="not_connected"&&!current(prepared.setup!==null))return skipped;return await recordFailure(cause,storage,lapId,key);}
  };
}
async function recordFailure(cause:unknown,storage:OnlineUploadStorage,lapId:number,key:string):Promise<OnlineUploadAttemptResult>{
  if(cause instanceof OnlineAdapterError){
    const terminalCodes=["activity_identity_ambiguous","activity_owner_conflict","lap_owner_conflict","lap_identity_conflict","unsupported_recording_format","recording_too_large","unknown_track","unknown_car","unsupported_game","f1_sanitization_failed"];
    const terminal=cause.responseStatus!==null&&!cause.retryable&&terminalCodes.includes(cause.code);
    if(terminal){
      const result=await storage.settleOnlineLapUpload(lapId,key,cause.code==="invalid_response"?"validation_rejected":cause.code,null,null);
      return result?{status:"rejected",error:{code:"validation_rejected",retryable:false,retryAfter:null}}:{status:"skipped",error:null};
    }
    await storage.setOnlineLapRetryAfter(lapId,key,cause.retryAfter);
    return {status:"retry",error:{code:cause.code==="invalid_response"?"internal_error":cause.code,retryable:true,retryAfter:cause.retryAfter}};
  }
  await storage.setOnlineLapRetryAfter(lapId,key,null);
  return {status:"retry",error:getOnlineRecordingError(cause)};
}

