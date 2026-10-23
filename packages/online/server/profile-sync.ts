import type { ProfileCoordinatorPort } from "./profile-coordinator";
import type { api } from "@speedhq/live-client";
import type { OnlineError, ProfileActivityContribution } from "../contracts/index";
import type { RaceIqOnlineService } from "./service";
import { OnlineAdapterError } from "./adapter";
import { admitProfileDelivery,beginProfileDelivery,settleProfileDelivery } from "./profile-storage";
import type { ActivityContributionHashProvider } from "./profile-coordinator";
type ValidatedProfileContribution = ProfileActivityContribution;
type PreparedDriverSummaryContribution = { activityId: string; ownerUserId: string | null; gameId: string; lapGuids: string[]; payload: unknown; contentHash: string; expectedCloudRevision: number | null; state: "ready" | "held_ambiguous" | "conflict" | "synced"; heldReason: string | null };
export interface OnlineProfileSyncPlatform {
  getLocalAccountOwner(): Promise<string | null>;
  prepareDriverSummaryContributions(hash: ActivityContributionHashProvider): Promise<PreparedDriverSummaryContribution[]>;
  listReadyDriverSummaryContributionPage(cursor: string | null, limit: number): Promise<{ items: { ownerUserId: string | null; state: string; activityId: string; contentHash: string; gameId: string; expectedCloudRevision: number | null; payloadJson: string }[]; nextCursor: string | null }>;
  hasPendingDriverSummaryPreparations(): Promise<boolean>;
  isDriverSummaryContributionCurrent(activityId: string, contentHash: string): Promise<boolean>;
  recordDriverSummaryReceipt(receipt: api.ActivityContributionView["receipt"], options: { source: "owner_readback"; ownerUserId: string; status: "confirmed"; contribution: ValidatedProfileContribution; hash: ActivityContributionHashProvider }): Promise<void>;
  recordDriverSummaryHold(input: { receipt: api.ActivityContributionView["receipt"]; contribution: ValidatedProfileContribution; status: "held"; holdReason: string | null }, options: { ownerUserId: string; hash: ActivityContributionHashProvider }): Promise<void>;
}

function isSourceReadback(view:api.ActivityContributionView):view is api.ActivityContributionView&{contribution:ValidatedProfileContribution;holdReason:string|null}{
  view.contribution.expectedRevision??=null;
  view.holdReason??=null;
  return view.contribution.schemaVersion===2&&(view.contribution.expectedRevision===null
    ||Number.isSafeInteger(view.contribution.expectedRevision)&&view.contribution.expectedRevision>=0);
}

export function createOnlineProfileSync(service:RaceIqOnlineService,platform:OnlineProfileSyncPlatform):ProfileCoordinatorPort {
  let readyCursor:string|null=null;
  let readyAccountId:string|null=null;
  let readyAccountEpoch:string|null=null;
  return {
    service,
    async prepare(context,hash) {
      if(await platform.getLocalAccountOwner()!==context.accountId||!service.isProfileSyncContextCurrent(context))return false;
      if(readyAccountId!==context.accountId||readyAccountEpoch!==context.accountEpoch){
        readyCursor=null;readyAccountId=context.accountId;readyAccountEpoch=context.accountEpoch;
      }
      await platform.prepareDriverSummaryContributions(hash);
      await Bun.sleep(0);
      if(!service.isProfileSyncContextCurrent(context))return false;
      const page=await platform.listReadyDriverSummaryContributionPage(readyCursor,64);
      for(const record of page.items) {
        if(!service.isProfileSyncContextCurrent(context))return false;
        if(record.ownerUserId!==context.accountId||record.state!=="ready")continue;
        await admitProfileDelivery({accountId:context.accountId,activityId:record.activityId,contentHash:record.contentHash,gameId:record.gameId,
          activityRevision:record.expectedCloudRevision,payloadJson:record.payloadJson});
        await Bun.sleep(0);
      }
      readyCursor=page.nextCursor;
      return readyCursor!==null||await platform.hasPendingDriverSummaryPreparations();
    },
    async deliver(delivery,context,mayStart,hash) {
      if(!mayStart()||delivery.accountId!==context.accountId||await platform.getLocalAccountOwner()!==delivery.accountId) return "retry";
      const contribution=JSON.parse(delivery.payloadJson) as api.ActivityContribution;
      const {expectedRevision:_revision,contentHash,...body}=contribution;
      if(contribution.activityId!==delivery.activityId||contentHash!==delivery.contentHash||await hash(body)!==contentHash) {
        await settleProfileDelivery(delivery,"rejected",{code:"activity_revision_conflict",retryable:false,retryAfter:null});return "ack";
      }
      if(!mayStart()) return "retry";
      const sourceCurrent=async()=>mayStart()&&await platform.isDriverSummaryContributionCurrent(delivery.activityId,delivery.contentHash)&&mayStart();
      let minimumRevision=delivery.activityRevision??0;
      const readback=async()=>{
        const view=await service.readActivityReceipt(delivery.activityId,context);
        if(view){
          if(!isSourceReadback(view))throw new OnlineAdapterError("invalid_response",false);
          const {expectedRevision:_expected,contentHash:receivedHash,...receivedBody}=view.contribution;
          if(view.receipt.activityId!==delivery.activityId||view.contribution.activityId!==delivery.activityId||view.receipt.contentHash!==receivedHash
            ||!Number.isSafeInteger(view.receipt.revision)||view.receipt.revision<0||(view.status==="confirmed"&&view.receipt.revision<1)||view.receipt.revision<minimumRevision
            ||await hash(receivedBody)!==receivedHash)throw new OnlineAdapterError("invalid_response",false);
          minimumRevision=view.receipt.revision;
          if(mayStart()){
            if(view.status==="confirmed")await platform.recordDriverSummaryReceipt(view.receipt,{source:"owner_readback",ownerUserId:context.accountId,status:"confirmed",contribution:view.contribution,hash});
            else await platform.recordDriverSummaryHold({receipt:view.receipt,contribution:view.contribution,status:"held",holdReason:view.holdReason},{ownerUserId:context.accountId,hash});
          }
          return view;
        }
        return null;
      };
      try {
        // Always read back first; a receipt may have arrived before a crash or lost response.
        const existing=await readback();
        if(!mayStart()) return "retry";
        if(existing?.status==="confirmed"&&existing.receipt.contentHash===delivery.contentHash) {
          await settleProfileDelivery(delivery,"accepted",null,existing.receipt.revision);return "ack";
        }
        if(existing?.status==="confirmed"&&await platform.isDriverSummaryContributionCurrent(delivery.activityId,existing.receipt.contentHash)) {
          if(!mayStart())return "retry";
          // A different queued payload is obsolete once the current source matches owner readback.
          await settleProfileDelivery(delivery,"superseded",delivery.error);return "ack";
        }
        if(existing&&existing.status!=="confirmed"){
          const correction=existing.receipt.contentHash!==delivery.contentHash&&contribution.expectedRevision===existing.receipt.revision&&delivery.state!=="blocked";
          if(!correction){await settleProfileDelivery(delivery,"blocked",{code:"activity_identity_ambiguous",retryable:false,retryAfter:null},existing.receipt.revision);return "retry";}
        }
        if(existing&&existing.receipt.revision>(contribution.expectedRevision??0)) {
          await settleProfileDelivery(delivery,"blocked",{code:"activity_revision_conflict",retryable:false,retryAfter:null},existing.receipt.revision);return "retry";
        }
        if(delivery.state==="blocked")return "retry";
        await Bun.sleep(0);
        if(!await sourceCurrent()){
          if(!mayStart())return "retry";
          await settleProfileDelivery(delivery,"blocked",{code:"activity_revision_conflict",retryable:false,retryAfter:null});return "retry";
        }
        if(!mayStart()||!await beginProfileDelivery(delivery)||!mayStart()) return "retry";
        const receipt=await service.writeActivityContribution(contribution,context,sourceCurrent);
        if(receipt.activityId!==delivery.activityId||receipt.contentHash!==delivery.contentHash||!Number.isSafeInteger(receipt.revision)||receipt.revision<0||receipt.revision<minimumRevision)throw new OnlineAdapterError("invalid_response",false);
        minimumRevision=receipt.revision;
        // A write response is only a provisional revision; public confirmation requires owner readback.
        await settleProfileDelivery(delivery,"ambiguous",null,receipt.revision);
        if(!mayStart())return "retry";
        const confirmed=await readback();
        if(!mayStart())return "retry";
        if(!confirmed){await settleProfileDelivery(delivery,"ambiguous",{code:"service_unavailable",retryable:true,retryAfter:null});return "retry";}
        if(confirmed.status!=="confirmed"){
          await settleProfileDelivery(delivery,"blocked",{code:"activity_identity_ambiguous",retryable:false,retryAfter:null},confirmed.receipt.revision);return "retry";
        }
        if(confirmed.receipt.contentHash!==delivery.contentHash){await settleProfileDelivery(delivery,"blocked",{code:"activity_revision_conflict",retryable:false,retryAfter:null},confirmed.receipt.revision);return "retry";}
        await settleProfileDelivery(delivery,"accepted",null,confirmed.receipt.revision);
        return "ack";
      } catch(cause) {
        if(!mayStart())return "retry";
        if(cause instanceof OnlineAdapterError) {
          const code=cause.code==="invalid_response"?"internal_error":cause.code;
          const error:OnlineError={code,retryable:cause.retryable,retryAfter:cause.retryAfter};
          if(cause.code==="activity_revision_conflict"&&cause.responseStatus===null){await settleProfileDelivery(delivery,"blocked",error);return "retry";}
          if(cause.code==="not_connected"||cause.code==="auth_failed"||cause.code==="policy_changed"||cause.code==="policy_unavailable"){
            await settleProfileDelivery(delivery,"queued",{...error,retryable:true});return "retry";
          }
          // Missing response/5xx may mean accepted: retain the same body/key until readback.
          const ambiguous=cause.responseStatus===null||(cause.responseStatus!==null&&cause.responseStatus>=500);
          if(ambiguous) { await settleProfileDelivery(delivery,"ambiguous",{...error,retryable:true});return "retry"; }
          if(cause.retryable) { await settleProfileDelivery(delivery,delivery.attempts+1>=5?"blocked":"queued",error);return "retry"; }
          await settleProfileDelivery(delivery,"blocked",error);return "retry";
        }
        if(cause instanceof Error&&"code"in cause){
          const code=cause.code==="activity_identity_conflict"||cause.code==="activity_identity_ambiguous"?"activity_identity_ambiguous"
            :cause.code==="stale_source"||cause.code==="activity_revision_conflict"?"activity_revision_conflict"
            :cause.code==="activity_owner_conflict"?"activity_owner_conflict":null;
          if(code){await settleProfileDelivery(delivery,"blocked",{code,retryable:false,retryAfter:null});return "retry";}
        }
        await settleProfileDelivery(delivery,"ambiguous",{code:"service_unavailable",retryable:true,retryAfter:null});
        return "retry";
      }
    },
  };
}
