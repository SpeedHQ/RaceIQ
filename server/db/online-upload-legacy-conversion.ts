import Database from "libsql";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, readDb } from "./index";
import { withDatabaseWrite } from "./write-coordination";
import { resolveDataDir } from "../runtime/config/data-dir";

const LEGACY_DB = join(resolveDataDir(), "raceiq-online-outbox.db");
type LegacyRow = { lapId:number; accountId:string; status:string; idempotencyKey:string|null; identityJson:string|null; fingerprint:string|null; reservationToken:string|null; remoteJobId:string|null; transmittedAt:number|null; updatedAt:number|null; errorCode:string|null };
type LegacyBoardReceipt = {accountId:string;lapId:number|null;identityJson:string|null;remoteJobId:string|null;acceptedAt:string|null};
type Request = Pick<LegacyRow,"accountId"|"idempotencyKey"|"identityJson"|"fingerprint">;
function column(columns:Set<string>,name:string,alias:string):string { return columns.has(name) ? `"${name}" AS "${alias}"` : `NULL AS "${alias}"`; }
function validRequest(row:LegacyRow):boolean {
  if (!row.idempotencyKey || !row.identityJson || !row.accountId) return false;
  try {
    const identity = JSON.parse(row.identityJson) as Record<string,unknown>;
    return typeof identity.lapGuid === "string" && typeof identity.originalActivityId === "string" &&
      typeof identity.sourceRevision === "string" && (identity.sourceKind === "native_capture" || identity.sourceKind === "verified_portable") &&
      identity.ownerUserId === row.accountId && typeof identity.driverBindingId === "string" &&
      Number.isSafeInteger(identity.driverBindingRevision) && (row.fingerprint === null || /^[a-f0-9]{64}$/i.test(row.fingerprint));
  } catch { return false; }
}
function sameRequest(a:Request,b:Request):boolean {
  return a.accountId===b.accountId&&a.idempotencyKey===b.idempotencyKey&&a.identityJson===b.identityJson&&a.fingerprint===b.fingerprint;
}
function readLegacy():LegacyRow[] {
  if (!existsSync(LEGACY_DB)) return [];
  const legacy=new Database(LEGACY_DB,{readonly:true,fileMustExist:true});
  try {
    legacy.exec("PRAGMA query_only=ON");
    if (!legacy.prepare<[]>("SELECT name FROM sqlite_master WHERE type='table' AND name='raceiq_online_outbox'").all().length) return [];
    const columns=new Set((legacy.prepare<[]>("PRAGMA table_info(raceiq_online_outbox)").all() as {name:string}[]).map(row=>row.name));
    const fields=["lap_id AS lapId","account_id AS accountId","status",column(columns,"upload_key","idempotencyKey"),
      column(columns,"identity_json","identityJson"),column(columns,"payload_fingerprint","fingerprint"),
      column(columns,"reservation_token","reservationToken"),column(columns,"remote_job_id","remoteJobId"),
      column(columns,"transmitted_at","transmittedAt"),column(columns,"updated_at","updatedAt"),column(columns,"last_error_code","errorCode")].join(",");
    return legacy.prepare<[]>(`SELECT ${fields} FROM raceiq_online_outbox ORDER BY lap_id,row_id`).all() as LegacyRow[];
  } finally { legacy.close(); }
}
async function readBoardReceipts():Promise<LegacyBoardReceipt[]> {
  const exists=await readDb.all<{name:string}>(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='online_fastest_laps'`);
  if (!exists.length) return [];
  return readDb.all<LegacyBoardReceipt>(sql`SELECT account_id AS accountId,lap_id AS lapId,accepted_identity AS identityJson,
    remote_job_id AS remoteJobId,accepted_at AS acceptedAt FROM online_fastest_laps
    WHERE accepted_identity IS NOT NULL OR remote_job_id IS NOT NULL OR accepted_at IS NOT NULL`);
}
async function findSurvivingLap(identityJson:string,accountId:string):Promise<number|null> {
  try {
    const identity=JSON.parse(identityJson) as Record<string,unknown>;
    if(typeof identity.lapGuid!=="string"||typeof identity.originalActivityId!=="string"||identity.ownerUserId!==accountId)return null;
    const rows=await readDb.all<{id:number}>(sql`SELECT l.id FROM laps l JOIN sessions s ON s.id=l.session_id
      WHERE lower(l.lap_guid)=lower(${identity.lapGuid}) AND s.original_activity_id=${identity.originalActivityId}
        AND s.owner_user_id=${accountId}`);
    return rows.length===1?rows[0]!.id:null;
  } catch { return null; }
}
type LegacyReceipt = {result:string;remoteJobId:string|null;uploadedAt:string|null;resultAt:string};
function terminal(row:LegacyRow):LegacyReceipt|null {
  if (row.status === "transmitted" && row.remoteJobId && row.transmittedAt) {
    const at=new Date(row.transmittedAt).toISOString();
    return { result:"success",remoteJobId:row.remoteJobId,uploadedAt:at,resultAt:at };
  }
  if (row.status === "rejected" && row.errorCode && /^[a-z][a-z0-9_]{0,63}$/.test(row.errorCode)) {
    return { result:row.errorCode,remoteJobId:null,uploadedAt:null,resultAt:new Date(row.updatedAt??Date.now()).toISOString() };
  }
  return null;
}
async function blockLap(lapId:number):Promise<void> {
  await withDatabaseWrite(()=>db.run(sql`UPDATE laps SET online_upload_blocked_reason='legacy_request_ambiguous' WHERE id=${lapId}`));
}
async function retain(lapId:number,row:LegacyRow,receipt:LegacyReceipt|null):Promise<boolean> {
  const changed=await withDatabaseWrite(()=>db.run(sql`UPDATE laps SET
    online_account_id=${row.accountId},online_idempotency_key=${row.idempotencyKey},online_identity_json=${row.identityJson},
    online_payload_fingerprint=${row.fingerprint},online_reservation_token=${row.reservationToken},
    online_remote_job_id=${receipt?.remoteJobId??null},online_upload_result=${receipt?.result??null},
    online_uploaded_at=${receipt?.uploadedAt??null},online_result_at=${receipt?.resultAt??null}
    WHERE id=${lapId} AND online_account_id IS NULL AND online_idempotency_key IS NULL AND online_identity_json IS NULL
      AND online_payload_fingerprint IS NULL AND online_reservation_token IS NULL AND online_remote_job_id IS NULL
      AND online_upload_result IS NULL`));
  if (changed.rowsAffected===1) return true;
  const existing=await readDb.all<{accountId:string|null;key:string|null;identity:string|null;fingerprint:string|null;token:string|null;remote:string|null;result:string|null}>(sql`SELECT online_account_id AS accountId,online_idempotency_key AS key,online_identity_json AS identity,online_payload_fingerprint AS fingerprint,online_reservation_token AS token,online_remote_job_id AS remote,online_upload_result AS result FROM laps WHERE id=${lapId}`);
  const current=existing[0];
  if (!current) return true;
  const exact=current.accountId===row.accountId&&current.key===row.idempotencyKey&&current.identity===row.identityJson&&current.fingerprint===row.fingerprint&&current.token===row.reservationToken;
  return exact && (!receipt || current.result===receipt.result&&current.remote===receipt.remoteJobId);
}

/** Converts legacy LAP identities and receipts once; legacy DB remains read-only and intact. */
export async function convertLegacyOnlineLapRequests():Promise<void> {
  const state=await readDb.all<{complete:number}>(sql`SELECT complete FROM online_legacy_upload_conversion_state WHERE id=1`);
  if (state[0]?.complete===1) return;
  const rows=readLegacy();
  const grouped=new Map<number,LegacyRow[]>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.lapId)||row.lapId<1) continue;
    const group=grouped.get(row.lapId)??[];group.push(row);grouped.set(row.lapId,group);
  }
  const blockedLaps=new Set<number>();
  const receiptByLap=new Map<number,LegacyReceipt>();
  for (const cached of await readBoardReceipts()) {
    if (cached.identityJson===null&&cached.remoteJobId===null&&cached.acceptedAt===null) continue;
    let targetLap=cached.lapId;
    let identityMapsToLap=false;
    if (cached.identityJson) {
      try {
        const identity=JSON.parse(cached.identityJson) as Record<string,unknown>;
        if(typeof identity.lapGuid==="string"&&typeof identity.originalActivityId==="string"&&identity.ownerUserId===cached.accountId){
          identityMapsToLap=true;
          targetLap=await findSurvivingLap(cached.identityJson,cached.accountId);
        }
      } catch {}
    }
    if(targetLap===null||!Number.isSafeInteger(targetLap)||targetLap<1){
      if(identityMapsToLap) continue;
      continue;
    }
    const acceptedAt=Date.parse(cached.acceptedAt??"");
    const matches=rows.filter(row=>row.accountId===cached.accountId&&row.identityJson===cached.identityJson&&
      row.remoteJobId===cached.remoteJobId&&row.status==="transmitted"&&terminal(row)?.result==="success"&&validRequest(row));
    const sameReceipt=matches.length>0&&matches.every(row=>sameRequest(matches[0]!,row)&&row.remoteJobId===matches[0]!.remoteJobId);
    if(!cached.identityJson||!cached.remoteJobId||!Number.isFinite(acceptedAt)||!sameReceipt||matches[0]!.lapId!==targetLap){
      for(const row of matches)if(Number.isSafeInteger(row.lapId)&&row.lapId>0)blockedLaps.add(row.lapId);
      blockedLaps.add(targetLap);
      continue;
    }
    const at=new Date(acceptedAt).toISOString();
    const prior=receiptByLap.get(targetLap);
    if(prior&&prior.remoteJobId!==cached.remoteJobId){blockedLaps.add(targetLap);receiptByLap.delete(targetLap);}
    else receiptByLap.set(targetLap,{result:"success",remoteJobId:cached.remoteJobId,uploadedAt:at,resultAt:at});
  }
  let blocked=0;
  for(const lapId of blockedLaps){await blockLap(lapId);blocked++;}
  for (const [lapId,group] of grouped) {
    if(blockedLaps.has(lapId))continue;
    const first=group[0]!;
    const sameImmutableRequest=group.every(row=>sameRequest(first,row));
    const receipts=group.map(terminal).filter((value):value is LegacyReceipt=>value!==null);
    const receipt=receiptByLap.get(lapId)??receipts[0]??null;
    const conflict=!sameImmutableRequest||new Set(receipts.map(item=>`${item.result}:${item.remoteJobId}`)).size>1;
    const latest=[...group].sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0))[0]!;
    const selected={...latest,reservationToken:latest.reservationToken??first.reservationToken};
    if (conflict||!group.every(validRequest)) { await blockLap(lapId);blocked++;continue; }
    if (!await retain(lapId,selected,receipt)) { await blockLap(lapId);blocked++; }
  }
  await withDatabaseWrite(()=>db.run(sql`INSERT INTO online_legacy_upload_conversion_state(id,complete) VALUES(1,1)
    ON CONFLICT(id) DO UPDATE SET complete=1`));
  if (blocked) console.error(`[OnlineUpload] Legacy request conversion blocked ${blocked} ambiguous lap(s); original outbox database and legacy receipt cache preserved`);
}
