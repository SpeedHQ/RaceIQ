import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client/sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOnlineDataDir } from "./runtime";
import type { OnlineError, UploadItem } from "./contracts";

export interface ProfileDelivery {
  id: string; accountId: string; activityId: string; contentHash: string; gameId: string;
  payloadJson: string;
  activityRevision: number | null; state: "queued" | "ambiguous" | "accepted" | "rejected" | "blocked" | "superseded";
  admittedAt: number; updatedAt: number; acceptedAt: number | null; attempts: number; retryNotBeforeAt: number; error: OnlineError | null;
}
let client: Client | null = null;
let initialization: Promise<void> | null = null;
async function storage(): Promise<Client> {
  if (!client) { const directory=resolveOnlineDataDir(); mkdirSync(directory,{recursive:true}); client=createClient({url:`file:${join(directory,"raceiq-online-profile-deliveries.db")}`}); }
  const active=client;
  initialization ??= (async () => {
    await active.execute("PRAGMA journal_mode=WAL");
    await active.execute("PRAGMA synchronous=FULL");
    await active.execute(`CREATE TABLE IF NOT EXISTS profile_deliveries (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,activity_id TEXT NOT NULL,content_hash TEXT NOT NULL,game_id TEXT NOT NULL,
      activity_revision INTEGER,payload_json TEXT NOT NULL,state TEXT NOT NULL,admitted_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,accepted_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,retry_not_before_at INTEGER NOT NULL DEFAULT 0,error_json TEXT)`);
    await active.execute("CREATE INDEX IF NOT EXISTS profile_delivery_owner ON profile_deliveries(account_id,state,admitted_at,id)");
    await active.execute("CREATE INDEX IF NOT EXISTS profile_delivery_activity ON profile_deliveries(account_id,activity_id,content_hash)");
  })();
  await initialization;
  return active;
}
function decode(row: Record<string,unknown>): ProfileDelivery {
  return { id:String(row.id),accountId:String(row.account_id),activityId:String(row.activity_id),contentHash:String(row.content_hash),gameId:String(row.game_id),
    activityRevision:row.activity_revision==null?null:Number(row.activity_revision),state:row.state as ProfileDelivery["state"],
    admittedAt:Number(row.admitted_at),updatedAt:Number(row.updated_at),acceptedAt:row.accepted_at==null?null:Number(row.accepted_at),attempts:Number(row.attempts),
    retryNotBeforeAt:Number(row.retry_not_before_at),payloadJson:String(row.payload_json),error:row.error_json==null?null:JSON.parse(String(row.error_json)) as OnlineError };
}
export async function admitProfileDelivery(input: { accountId:string;activityId:string;contentHash:string;gameId:string;activityRevision:number|null;payloadJson:string }): Promise<void> {
  const db=await storage(), now=Date.now();
  const id=createHash("sha256").update(JSON.stringify([input.accountId,input.activityId,input.contentHash,input.activityRevision])).digest("hex");
  await db.execute({sql:`INSERT INTO profile_deliveries(id,account_id,activity_id,content_hash,game_id,activity_revision,payload_json,state,admitted_at,updated_at)
    SELECT ?,?,?,?,?,?,?,'queued',?,? WHERE NOT EXISTS(SELECT 1 FROM profile_deliveries WHERE account_id=? AND activity_id=? AND state IN ('queued','ambiguous'))
    AND NOT EXISTS(SELECT 1 FROM profile_deliveries WHERE account_id=? AND activity_id=? AND content_hash=? AND payload_json=?)
    ON CONFLICT(id) DO NOTHING`,args:[id,input.accountId,input.activityId,input.contentHash,input.gameId,input.activityRevision,input.payloadJson,now,now,input.accountId,input.activityId,input.accountId,input.activityId,input.contentHash,input.payloadJson]});
}
export async function listProfileDeliveries(accountId:string): Promise<ProfileDelivery[]> {
  const db=await storage();
  const result=await db.execute({sql:"SELECT * FROM profile_deliveries WHERE account_id=? AND state IN ('queued','ambiguous','blocked') ORDER BY CASE WHEN state='blocked' THEN 1 ELSE 0 END,retry_not_before_at,admitted_at,id LIMIT 100",args:[accountId]});
  return result.rows.map(decode);
}
export async function getProfileDelivery(id:string,accountId:string): Promise<ProfileDelivery|null> {
  const db=await storage(),result=await db.execute({sql:"SELECT * FROM profile_deliveries WHERE id=? AND account_id=?",args:[id,accountId]});
  return result.rows[0]?decode(result.rows[0]):null;
}
/** Mark ambiguous before the SDK call; a crash must reconcile, not assume no send. */
export async function beginProfileDelivery(delivery:ProfileDelivery): Promise<boolean> {
  const db=await storage();
  const result=await db.execute({sql:`UPDATE profile_deliveries SET state='ambiguous',attempts=attempts+1,updated_at=? WHERE id=? AND account_id=? AND state IN ('queued','ambiguous') AND retry_not_before_at<=?`,args:[Date.now(),delivery.id,delivery.accountId,Date.now()]});
  return result.rowsAffected===1;
}
export async function settleProfileDelivery(delivery:ProfileDelivery,state:ProfileDelivery["state"],error:OnlineError|null=null,revision:number|null=null):Promise<void> {
  const db=await storage(),now=Date.now(),tx=await db.transaction("write");
  try{
    const result=await tx.execute({sql:`UPDATE profile_deliveries SET state=?,error_json=?,updated_at=?,accepted_at=CASE WHEN ?='accepted' THEN COALESCE(accepted_at,?) ELSE accepted_at END,
      activity_revision=CASE WHEN ? IS NULL THEN activity_revision ELSE MAX(COALESCE(activity_revision,0),?) END,retry_not_before_at=?
      WHERE id=? AND account_id=? AND state NOT IN ('accepted','rejected','superseded')`,
      args:[state,error?JSON.stringify(error):null,now,state,now,revision,revision,error?.retryAfter?Date.parse(error.retryAfter):state==="blocked"?now+60_000:0,delivery.id,delivery.accountId]});
    if(state==="accepted"&&result.rowsAffected===1)await tx.execute({sql:"UPDATE profile_deliveries SET state='superseded',updated_at=? WHERE account_id=? AND activity_id=? AND id<>? AND state='blocked'",args:[now,delivery.accountId,delivery.activityId,delivery.id]});
    await tx.commit();
  }catch(cause){await tx.rollback();throw cause;}
}
export async function readProfileUploadItems(accountId:string,view:"queue"|"history",boundary:{time:number;id:string}|null,limit:number):Promise<UploadItem[]> {
  const db=await storage(),terminal=view==="history",field=terminal?"updated_at":"admitted_at",compare=terminal?"<":">",direction=terminal?"DESC":"ASC";
  const result=await db.execute({sql:`SELECT * FROM profile_deliveries WHERE account_id=? AND state ${terminal?"IN":"NOT IN"} ('accepted','rejected','superseded')
    ${boundary?`AND (${field} ${compare} ? OR (${field}=? AND ('profile:'||id) ${compare} ?))`:""} ORDER BY ${field} ${direction},id ${direction} LIMIT ?`,args:[accountId,...(boundary?[boundary.time,boundary.time,boundary.id]:[]),limit]});
  return result.rows.map((row):UploadItem=>{const item=decode(row);return {
    id:`profile:${item.id}`,kind:"profile",gameId:item.gameId,lapId:null,lapGuid:null,trackId:null,carId:null,delivery:item.state==="queued"&&item.retryNotBeforeAt>Date.now()?"retry_wait":item.state,
    admittedAt:new Date(item.admittedAt).toISOString(),updatedAt:new Date(item.updatedAt).toISOString(),settledAt:terminal?new Date(item.updatedAt).toISOString():null,
    attemptCount:item.attempts,nextAttemptAt:item.retryNotBeforeAt>Date.now()?new Date(item.retryNotBeforeAt).toISOString():null,acceptedAt:item.acceptedAt===null?null:new Date(item.acceptedAt).toISOString(),
    remoteJobId:null,validation:"not_requested",publication:"not_requested",error:item.error,activityId:item.activityId,activityRevision:item.activityRevision };
  });
}
export async function getProfileDeliveryCounts(accountId:string):Promise<{pending:number;lastConfirmedAt:string|null}> {
  const db=await storage(),result=await db.execute({sql:`SELECT SUM(CASE WHEN state IN ('queued','ambiguous','blocked') THEN 1 ELSE 0 END) AS pending,MAX(accepted_at) AS confirmed FROM profile_deliveries WHERE account_id=?`,args:[accountId]});
  const row=result.rows[0];return {pending:Number(row?.pending??0),lastConfirmedAt:row?.confirmed==null?null:new Date(Number(row.confirmed)).toISOString()};
}
export async function closeProfileStorage():Promise<void> { if(initialization) await initialization;client?.close();client=null;initialization=null; }
export async function ensureProfileStorage():Promise<void>{await storage();}
