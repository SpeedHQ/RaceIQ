import { createClient,type Client } from "@libsql/client/sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOnlineDataDir } from "./runtime";
import type { GameIdentityBinding } from "./contracts";
import type { RegisteredOnlineDriverBinding } from "./payload";

let client:Client|null=null;
let initialization:Promise<void>|null=null;
async function storage():Promise<Client>{
  if(!client){const directory=resolveOnlineDataDir();mkdirSync(directory,{recursive:true});client=createClient({url:`file:${join(directory,"raceiq-online-bindings.db")}`});}
  const active=client;
  initialization??=(async()=>{
    await active.execute("PRAGMA journal_mode=WAL");await active.execute("PRAGMA synchronous=FULL");
    await active.execute(`CREATE TABLE IF NOT EXISTS registered_bindings(account_id TEXT NOT NULL,local_id TEXT NOT NULL,local_revision INTEGER NOT NULL,
      descriptor_hash TEXT NOT NULL,remote_id TEXT NOT NULL,remote_revision INTEGER NOT NULL,confirmed_at TEXT NOT NULL,
      PRIMARY KEY(account_id,local_id,local_revision))`);
    await active.execute("CREATE TABLE IF NOT EXISTS local_binding_confirmations(descriptor_hash TEXT PRIMARY KEY,confirmed_at TEXT NOT NULL)");
  })();
  await initialization;return active;
}
function descriptorHash(binding:GameIdentityBinding):string{
  return createHash("sha256").update(JSON.stringify([binding.id,binding.revision,binding.gameId,binding.sourceKind,binding.nativeIdentity,binding.confirmation])).digest("hex");
}
export async function getRegisteredOnlineBinding(accountId:string,captured:GameIdentityBinding):Promise<RegisteredOnlineDriverBinding|null>{
  const db=await storage(),result=await db.execute({sql:"SELECT * FROM registered_bindings WHERE account_id=? AND local_id=? AND local_revision=?",args:[accountId,captured.id,captured.revision]});
  const row=result.rows[0];if(!row)return null;
  if(row.descriptor_hash!==descriptorHash(captured))throw Object.assign(new Error("driver_identity_required"),{code:"driver_identity_required"});
  return {id:String(row.remote_id),revision:Number(row.remote_revision)};
}
export async function retainRegisteredOnlineBinding(accountId:string,captured:GameIdentityBinding,remote:RegisteredOnlineDriverBinding):Promise<void>{
  if(!accountId||!remote.id||!Number.isSafeInteger(remote.revision)||remote.revision<1)throw new TypeError("Invalid registered binding identity");
  const db=await storage(),hash=descriptorHash(captured);
  await db.execute({sql:`INSERT INTO registered_bindings(account_id,local_id,local_revision,descriptor_hash,remote_id,remote_revision,confirmed_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,local_id,local_revision) DO NOTHING`,args:[accountId,captured.id,captured.revision,hash,remote.id,remote.revision,new Date().toISOString()]});
  const retained=await getRegisteredOnlineBinding(accountId,captured);
  if(!retained||retained.id!==remote.id||retained.revision!==remote.revision)throw Object.assign(new Error("driver_identity_required"),{code:"driver_identity_required"});
}
function confirmationDescriptorHash(binding:GameIdentityBinding):string{
  return createHash("sha256").update(JSON.stringify([binding.id,binding.gameId,binding.sourceKind,binding.nativeIdentity])).digest("hex");
}
/** Separate human action record; never rewrites native_verified captured evidence. */
export async function recordLocalBindingConfirmation(binding:GameIdentityBinding):Promise<void>{
  const db=await storage();
  await db.execute({sql:"INSERT INTO local_binding_confirmations(descriptor_hash,confirmed_at) VALUES(?,?) ON CONFLICT(descriptor_hash) DO NOTHING",
    args:[confirmationDescriptorHash(binding),new Date().toISOString()]});
}
export async function hasLocalBindingConfirmation(binding:GameIdentityBinding):Promise<boolean>{
  if(binding.confirmation==="user_confirmed")return true;
  const db=await storage(),result=await db.execute({sql:"SELECT 1 FROM local_binding_confirmations WHERE descriptor_hash=?",args:[confirmationDescriptorHash(binding)]});
  return result.rows.length===1;
}
export async function closeBindingStorage():Promise<void>{if(initialization)await initialization;client?.close();client=null;initialization=null;}
export async function ensureBindingStorage():Promise<void>{await storage();}
