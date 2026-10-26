import { expect,test } from "bun:test";
import { getRegisteredOnlineBinding,retainRegisteredOnlineBinding,hasLocalBindingConfirmation,recordLocalBindingConfirmation } from "../server/binding-storage";
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

