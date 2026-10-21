import { sql } from "drizzle-orm";
import { db } from "./index";
import { getLocalAccountOwner } from "./local-account-queries";
import { decodeNativeDriverBinding } from "../lap-detection/native-attribution";
import { isWholeLapSelf, type DriverAttributionStint } from "@raceiq/shared/driver-attribution";

export interface OnlineUploadCandidate {
  lapId: number;
  lapTimeMs: number;
  gameId: string;
  trackId: string;
  carId: string;
  valid: true;
  lapGuid:string;
  originalActivityId:string;
  ownerUserId:string;
  driverBindingId:string;
  driverBindingRevision:number;
}
export type OnlineUploadCandidateCursor=Pick<OnlineUploadCandidate,"gameId"|"trackId"|"carId"|"lapTimeMs"|"lapId">;
export interface OnlineUploadCandidatePage {items:OnlineUploadCandidate[];nextCursor:OnlineUploadCandidateCursor|null}
type CandidateRow = {
  lapId: number; lapGuid: string; lapTimeMs: number; gameId: string; trackId: string; carId: string;
  sessionId: number; sourceClockDomain: string; sourceLapStartMs: number; sourceLapEndMs: number; stintsJson: string;
  originalActivityId:string;
};
const PAGE_SIZE=256;

/** Bounded, ordered source evidence; the runtime selects the first actually preparable lap per board. */
export async function getOnlineUploadCandidatePage(cursor:OnlineUploadCandidateCursor|null=null):Promise<OnlineUploadCandidatePage> {
  const ownerUserId=await getLocalAccountOwner();
  if(!ownerUserId)return {items:[],nextCursor:null};
  const after=cursor??{gameId:"",trackId:"",carId:"",lapTimeMs:0,lapId:0};
  const rows=await db.all<CandidateRow>(sql`
    WITH candidates AS (
      SELECT laps.id AS lapId,laps.lap_guid AS lapGuid,sessions.id AS sessionId,
        CAST(ROUND(CASE WHEN laps.total_time_ms>0 THEN laps.total_time_ms ELSE laps.lap_time*1000 END) AS INTEGER) AS lapTimeMs,
        sessions.game_id AS gameId,sessions.track_id AS trackId,sessions.car_id AS carId,
        laps.source_clock_domain AS sourceClockDomain,laps.source_lap_start_ms AS sourceLapStartMs,
        laps.source_lap_end_ms AS sourceLapEndMs,laps.driver_attribution_stints AS stintsJson,
        sessions.original_activity_id AS originalActivityId
      FROM laps JOIN sessions ON sessions.id=laps.session_id
        JOIN lap_guid_reconciliation reconciliation ON reconciliation.lap_id=laps.id
          AND reconciliation.status='resolved' AND reconciliation.lap_guid=laps.lap_guid
          AND (reconciliation.source_guid IS NULL OR reconciliation.source_guid=laps.lap_guid)
      WHERE sessions.owner_user_id=${ownerUserId} AND sessions.ownership='mine'
        AND sessions.game_id IN ('acc','ac-evo','iracing','lmu','f1-2025')
        AND (sessions.game_id<>'f1-2025' OR sessions.car_id='41')
        AND sessions.cloud_import_origin IS NULL AND sessions.cloud_import_lap_id IS NULL
        AND sessions.raw_file IS NOT NULL AND sessions.raw_file NOT LIKE '%.motec.zip'
        AND laps.is_valid=1 AND laps.lap_time>0 AND laps.driver_attribution='Self' AND laps.lap_guid IS NOT NULL
        AND sessions.original_activity_id IS NOT NULL
        AND laps.raw_byte_offset IS NOT NULL AND laps.raw_frame_count>0
        AND laps.sector_times IS NOT NULL AND json_valid(laps.sector_times) AND json_array_length(laps.sector_times)>0
        AND NOT EXISTS(SELECT 1 FROM json_each(laps.sector_times) s WHERE CAST(s.value AS REAL)<=0)
    )
    SELECT * FROM candidates WHERE (gameId,trackId,carId,lapTimeMs,lapId)>
      (${after.gameId},${after.trackId},${after.carId},${after.lapTimeMs},${after.lapId})
    ORDER BY gameId,trackId,carId,lapTimeMs,lapId LIMIT ${PAGE_SIZE}
  `);
  const items:OnlineUploadCandidate[]=[];
  for(const row of rows){
    await Bun.sleep(0);
    if(!Number.isSafeInteger(row.lapId)||!Number.isSafeInteger(row.lapTimeMs)||row.lapTimeMs<=0)continue;
    let stints:DriverAttributionStint[];
    try{stints=JSON.parse(row.stintsJson) as DriverAttributionStint[];}catch{continue;}
    if(!Array.isArray(stints)||stints.some(stint=>stint===null||typeof stint!=="object")||!isWholeLapSelf(stints,row.sourceLapStartMs,row.sourceLapEndMs,row.sourceClockDomain))continue;
    const binding=stints[0]?.bindingSnapshot;
    if(!binding||binding.gameId!==row.gameId)continue;
    const descriptor=decodeNativeDriverBinding(binding.nativeIdentity);
    if(!descriptor||!stints.every(stint=>{
      const snapshot=stint.bindingSnapshot;
      return snapshot!==undefined&&snapshot.id===binding.id&&snapshot.revision===binding.revision&&snapshot.nativeIdentity===binding.nativeIdentity
        &&snapshot.confirmation===binding.confirmation&&snapshot.gameId===binding.gameId&&snapshot.sourceKind===binding.sourceKind
        &&snapshot.sourceKind===stint.source&&binding.revision===stint.bindingRevision
        &&descriptor.actorId===stint.actor?.actorId&&(descriptor.bindingScope!=="session"||descriptor.sessionId===stint.sessionId);
    }))continue;
    items.push({lapId:row.lapId,lapGuid:row.lapGuid,lapTimeMs:row.lapTimeMs,gameId:row.gameId,trackId:row.trackId,carId:row.carId,
      valid:true,ownerUserId,originalActivityId:row.originalActivityId,driverBindingId:binding.id,driverBindingRevision:binding.revision});
  }
  const last=rows.at(-1);
  const nextCursor=rows.length===PAGE_SIZE&&last?{gameId:last.gameId,trackId:last.trackId,carId:last.carId,lapTimeMs:last.lapTimeMs,lapId:last.lapId}:null;
  return {items,nextCursor};
}
