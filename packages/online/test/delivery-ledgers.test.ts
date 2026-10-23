import { expect,test } from "bun:test";
import { getRegisteredOnlineBinding,retainRegisteredOnlineBinding,hasLocalBindingConfirmation,recordLocalBindingConfirmation } from "../server/binding-storage";
import { admitProfileDelivery,listProfileDeliveries,getProfileDelivery,beginProfileDelivery,settleProfileDelivery,readProfileUploadItems,getProfileDeliveryCounts } from "../server/profile-storage";
import type { GameIdentityBinding } from "../contracts/index";

function capturedBinding():GameIdentityBinding {
  return {id:crypto.randomUUID(),gameId:"f1-2025",sourceKind:"f1-2025-udp-local-controller",nativeIdentity:JSON.stringify({schemaVersion:1,actorId:"original-session:local-player",bindingScope:"session",sessionId:"original-session"}),confirmation:"native_verified",revision:4};
}
test("explicit confirmation and remote registration never rewrite original native evidence or cross account ownership",async()=>{
  const captured=capturedBinding(),owner=crypto.randomUUID(),other=crypto.randomUUID();
  expect(await hasLocalBindingConfirmation(captured)).toBe(false);
  await recordLocalBindingConfirmation(captured);
  expect(await hasLocalBindingConfirmation(captured)).toBe(true);
  expect(captured.confirmation).toBe("native_verified");
  const remote={id:"cloud-binding",revision:12};
  await retainRegisteredOnlineBinding(owner,captured,remote);
  expect(await getRegisteredOnlineBinding(owner,captured)).toEqual(remote);
  expect(captured.revision).toBe(4);
  expect(await getRegisteredOnlineBinding(other,captured)).toBeNull();
  const unrelated={...captured,nativeIdentity:JSON.stringify({schemaVersion:1,actorId:"new-session:local-player",bindingScope:"session",sessionId:"new-session"})};
  expect(await hasLocalBindingConfirmation(unrelated)).toBe(false);
  await expect(getRegisteredOnlineBinding(owner,unrelated)).rejects.toMatchObject({code:"driver_identity_required"});
});

test("profile ambiguous receipt retains immutable body and correction admission waits for confirmed settlement",async()=>{
  const accountId=crypto.randomUUID(),activityId=crypto.randomUUID();
  const initial={accountId,activityId,contentHash:"a".repeat(64),gameId:"acc",activityRevision:null,payloadJson:JSON.stringify({activityId,contentHash:"a".repeat(64),expectedRevision:null})};
  await admitProfileDelivery(initial);
  const [delivery]=await listProfileDeliveries(accountId);
  expect(await beginProfileDelivery(delivery)).toBe(true);
  await settleProfileDelivery(delivery,"ambiguous",{code:"offline",retryable:true,retryAfter:null});
  await admitProfileDelivery({...initial,contentHash:"b".repeat(64),payloadJson:JSON.stringify({activityId,contentHash:"b".repeat(64),expectedRevision:null})});
  expect((await listProfileDeliveries(accountId)).map(item=>item.contentHash)).toEqual([initial.contentHash]);
  expect((await getProfileDelivery(delivery.id,accountId))?.payloadJson).toBe(initial.payloadJson);
  expect(await getProfileDelivery(delivery.id,"another-owner")).toBeNull();
  expect(await getProfileDeliveryCounts(accountId)).toEqual({pending:1,lastConfirmedAt:null});
  await settleProfileDelivery(delivery,"accepted",null,3);
  const history=await readProfileUploadItems(accountId,"history",null,50);
  expect(history[0]).toMatchObject({delivery:"accepted",activityId,activityRevision:3,validation:"not_requested",publication:"not_requested"});
  expect((await getProfileDeliveryCounts(accountId)).lastConfirmedAt).toBe(history[0].acceptedAt);
  expect(await readProfileUploadItems(accountId,"queue",null,50)).toEqual([]);
  await admitProfileDelivery({...initial,contentHash:"b".repeat(64),activityRevision:3,payloadJson:JSON.stringify({activityId,contentHash:"b".repeat(64),expectedRevision:3})});
  expect((await listProfileDeliveries(accountId)).map(item=>item.contentHash)).toEqual(["b".repeat(64)]);
  expect((await readProfileUploadItems(accountId,"history",null,50))[0].id).toBe(history[0].id);
  const [corrected]=await listProfileDeliveries(accountId);
  expect(await beginProfileDelivery(corrected)).toBe(true);
  await settleProfileDelivery(corrected,"accepted",null,4);
  const restoredPayload=JSON.stringify({activityId,contentHash:initial.contentHash,expectedRevision:4});
  await admitProfileDelivery({...initial,activityRevision:4,payloadJson:restoredPayload});
  const [restored]=await listProfileDeliveries(accountId);
  expect(restored.id).not.toBe(delivery.id);
  expect(restored.payloadJson).toBe(restoredPayload);
  expect((await getProfileDelivery(delivery.id,accountId))?.payloadJson).toBe(initial.payloadJson);
  expect((await getProfileDelivery(delivery.id,accountId))?.activityRevision).toBe(3);
});

test("held profile body survives until an accepted same-ID zero correction supersedes its retry",async()=>{
  const accountId=crypto.randomUUID(),activityId=crypto.randomUUID();
  const payloadJson=JSON.stringify({activityId,contentHash:"c".repeat(64),expectedRevision:null,summary:{laps:2,seconds:180}});
  await admitProfileDelivery({accountId,activityId,contentHash:"c".repeat(64),gameId:"acc",activityRevision:null,payloadJson});
  const [held]=await listProfileDeliveries(accountId);
  expect(await beginProfileDelivery(held)).toBe(true);
  await settleProfileDelivery(held,"blocked",{code:"activity_identity_ambiguous",retryable:false,retryAfter:null},7);
  expect(await getProfileDeliveryCounts(accountId)).toEqual({pending:1,lastConfirmedAt:null});
  await admitProfileDelivery({accountId,activityId,contentHash:"d".repeat(64),gameId:"acc",activityRevision:7,
    payloadJson:JSON.stringify({activityId,contentHash:"d".repeat(64),expectedRevision:7,summary:{laps:0,seconds:0}})});
  const [correction]=await listProfileDeliveries(accountId);
  expect(correction.contentHash).toBe("d".repeat(64));
  expect((await getProfileDelivery(held.id,accountId))?.payloadJson).toBe(payloadJson);
  expect(await beginProfileDelivery(correction)).toBe(true);
  await settleProfileDelivery(correction,"accepted",null,8);
  expect((await getProfileDelivery(held.id,accountId))?.state).toBe("superseded");
  expect((await getProfileDelivery(correction.id,accountId))?.activityRevision).toBe(8);
  expect((await getProfileDeliveryCounts(accountId)).pending).toBe(0);
});
