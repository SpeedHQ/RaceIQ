import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createServer } from "node:http";
import Database from "libsql";

const desktopRoot = join(import.meta.dir, "../../../..");
const cloudRoot = process.env.RACEIQ_CLOUD_ROOT;
const sourceData = process.env.RACEIQ_UPLOAD_SOURCE_DATA_DIR;
const certFile = process.env.RACEIQ_UPLOAD_TEST_CERT;
const keyFile = process.env.RACEIQ_UPLOAD_TEST_KEY;
assert.ok(cloudRoot && sourceData && certFile && keyFile, "Cloud root, genuine native source, and disposable TLS cert/key required");
const sourceReal = await realpath(sourceData);
assert.ok(sourceReal.startsWith(`${await realpath(tmpdir())}${sep}`), "Refuse native source outside temporary storage");
const temporary = await mkdtemp(join(tmpdir(), "raceiq-upload-lifecycle-"));
const sourceDb = new Database(join(sourceReal, "app.db"), { readonly: true });
const owner = sourceDb.prepare("SELECT online_user_id AS id FROM local_account_owner WHERE id=1").get()?.id;
assert.ok(owner, "Native source must retain original account owner");
const sourceWinners = sourceDb.prepare(`SELECT s.game_id AS gameId,s.track_id AS trackId,s.car_id AS carId,
  l.id AS lapId,l.lap_guid AS guid,l.is_valid AS valid,l.driver_attribution AS attribution,
  COALESCE(s.capture_archive_file,s.capture_manifest_file,s.raw_file) AS artifact
  FROM sessions s JOIN laps l ON l.session_id=s.id WHERE s.native_capture_origin=1
  AND s.game_id IN ('f1-2025','lmu') AND l.is_valid=1 AND l.driver_attribution='Self' AND l.lap_guid IS NOT NULL
  ORDER BY s.game_id,COALESCE(l.total_time_ms,ROUND(l.lap_time*1000)),l.id`).all();
sourceDb.close();
const best = new Map<string, typeof sourceWinners[number]>();
for (const row of sourceWinners) {
  const key = JSON.stringify([row.gameId,row.trackId,row.carId]);
  if (!best.has(key)) best.set(key,row);
}
assert.ok([...best.values()].some(row => row.gameId === "f1-2025") && [...best.values()].some(row => row.gameId === "lmu"),
  "Genuine finalized source must contain F1 and LMU winners");

const children = new Set<Bun.Subprocess>();
const logs = new Map<Bun.Subprocess,string>();
function start(command: string[], cwd: string, env: Record<string,string>) {
  const child = Bun.spawn(command,{cwd,env:{PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR!,...env},stdout:"pipe",stderr:"pipe"});
  children.add(child); logs.set(child,"");
  for (const stream of [child.stdout,child.stderr]) void (async()=>{for await(const chunk of stream){const previous=logs.get(child)??"";logs.set(child,(previous+new TextDecoder().decode(chunk)).slice(-20_000));}})();
  return child;
}
async function stop(child?: Bun.Subprocess) {
  if (!child) return;
  if (child.exitCode === null) child.kill("SIGTERM");
  const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
  try { await child.exited; } finally { clearTimeout(timer); children.delete(child); }
}
async function ready(url:string) {
  const until=Date.now()+90000;
  while(Date.now()<until){try{if((await fetch(url)).status===200)return;}catch{} await Bun.sleep(100);}
  throw new Error(`Timed out waiting for ${url}`);
}
async function freePort() {
  const server=createServer(), listening=Promise.withResolvers<void>();
  server.listen(0,"127.0.0.1",listening.resolve); await listening.promise;
  const address=server.address(); assert.ok(address&&typeof address!=="string");
  const closed=Promise.withResolvers<void>(); server.close(error=>error?closed.reject(error):closed.resolve()); await closed.promise;
  return address.port;
}
const codes=new Map<string,{challenge:string;userId:string}>(), tokens=new Map<string,string>();
const betaOwner="b2345678-1234-5678-9abc-def012345678";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
let providerBase="",authOrigin="",apiBase="",appBase="";
const provider=async(request:Request)=>{
  const url=new URL(request.url);
  if(url.pathname==="/auth/v1/authorize"){
    const callback=new URL(url.searchParams.get("redirect_to")!);
    if(callback.protocol!=="http:"||callback.hostname!=="127.0.0.1"||callback.pathname!=="/api/online/auth/callback")return new Response(null,{status:400});
    const userId=owner; const code=randomUUID(); codes.set(code,{challenge:url.searchParams.get("code_challenge")!,userId}); callback.searchParams.set("code",code); return Response.redirect(callback.href,302);
  }
  if(url.pathname==="/auth/v1/token"){
    const body=await request.json() as {auth_code?:string;code_verifier?:string;refresh_token?:string};
    let userId:string|undefined;
    if(url.searchParams.get("grant_type")==="pkce"){
      const auth=codes.get(body.auth_code??""); codes.delete(body.auth_code??"");
      if(!auth||createHash("sha256").update(body.code_verifier??"").digest("base64url")!==auth.challenge)return new Response(null,{status:400});
      userId=auth.userId;
    }else{
      userId=body.refresh_token===`r03-local-refresh-${owner}`?owner:body.refresh_token===`r03-local-refresh-${betaOwner}`?betaOwner:undefined;
      if(!userId)return new Response(null,{status:401});
    }
    const exp=Math.floor(Date.now()/1000)+3600;
    const access=`${encode({alg:"HS256",typ:"JWT"})}.${encode({iss:`${providerBase}/auth/v1`,aud:"authenticated",role:"authenticated",sub:userId,exp,session_id:randomUUID()})}.isolated-signature`;
    tokens.set(access,userId); return Response.json({access_token:access,refresh_token:`r03-local-refresh-${userId}`,token_type:"bearer",expires_in:3600,user:{id:userId,user_metadata:{name:"Lifecycle owner"},identities:[]}});
  }
  const userId=tokens.get(request.headers.get("authorization")?.replace(/^Bearer /,"")??"");
  return userId&&url.pathname==="/auth/v1/user"?Response.json({id:userId,user_metadata:{name:"Lifecycle owner"},identities:[]}):new Response(null,{status:401});
};
const cert=await readFile(certFile,"utf8"),key=await readFile(keyFile,"utf8");
const plainProvider=Bun.serve({hostname:"127.0.0.1",port:0,fetch:provider}); providerBase=`http://127.0.0.1:${plainProvider.port}`;
const tlsProvider=Bun.serve({hostname:"127.0.0.1",port:0,tls:{cert,key},fetch:provider}); authOrigin=`https://127.0.0.1:${tlsProvider.port}`;
const apiPort=await freePort(),appPort=await freePort(),udpPort=await freePort(),metricsPort=await freePort();
apiBase=`http://127.0.0.1:${apiPort}`; appBase=`http://127.0.0.1:${appPort}`;
const multipartGuids:string[]=[]; let activeBodies=0,maximumActiveBodies=0,holdNextBody=true,profileWrites=0;
let heldBody=Promise.withResolvers<string>(),releaseBody=Promise.withResolvers<void>();
const policy={RACEIQ_TERMS_VERSION:"lifecycle-terms",RACEIQ_PRIVACY_VERSION:"lifecycle-privacy",RACEIQ_TERMS_URL:"https://example.test/terms",RACEIQ_PRIVACY_URL:"https://example.test/privacy"};
const storage={SQLITE_PATH:join(temporary,"cloud.sqlite"),UPLOAD_DIR:join(temporary,"uploads"),DISCORD_BOT_TOKEN:"",...policy};
const proxy=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const url=new URL(request.url),body=request.method==="GET"||request.method==="HEAD"?undefined:await request.clone().arrayBuffer();
  if(url.pathname.startsWith("/api/v1/me/stats/")&&["POST","PUT","PATCH","DELETE"].includes(request.method))profileWrites++;
  const multipart=(request.headers.get("content-type")??"").includes("multipart/form-data")&&body!==undefined;
  if(multipart){
    const guid=url.searchParams.get("lapGuid"); assert.ok(guid,"Multipart request must identify actual lap"); multipartGuids.push(guid);
    activeBodies++; maximumActiveBodies=Math.max(maximumActiveBodies,activeBodies);
    if(holdNextBody){holdNextBody=false;heldBody.resolve(guid);await releaseBody.promise;}
  }
  try{
    const headers=new Headers(request.headers); for(const name of ["host","connection","transfer-encoding"])headers.delete(name);
    if(headers.get("origin")===proxyBase)headers.set("origin",apiBase);
    return await fetch(`${apiBase}${url.pathname}${url.search}`,{method:request.method,headers,...(body?{body}:{}),redirect:"error"});
  }finally{if(multipart)activeBodies--;}
}});
const proxyBase=`http://127.0.0.1:${proxy.port}`;
const localClient=(baseUrl=appBase)=>{
  let cookie="",csrf="";
  return async(path:string,method="GET",body?:unknown)=>{
    const form=body instanceof FormData;
    const response=await fetch(baseUrl+path,{method,headers:{Origin:baseUrl,...(!form?{"Content-Type":"application/json"}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{"X-RaceIQ-CSRF":csrf}:{})},...(body===undefined?{}:{body:form?body:JSON.stringify(body)})});
    if(response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie")!.split(";")[0]!;
    csrf=response.headers.get("x-raceiq-csrf")??csrf;
    return {status:response.status,data:await response.json(),cookie};
  };
};
const onlineSummary=(state:any)=>({revision:state.revision,accountEpoch:state.accountEpoch,connection:state.connection,policy:state.policy,consent:state.consent,preferences:state.preferences,preferencePersistence:state.preferencePersistence,uploadAllowed:state.uploadAllowed,sync:state.sync});
async function ensureOnline(local:ReturnType<typeof localClient>){
  const initial=await local("/api/online/state");
  assert.equal(initial.status,200,`Online state request failed: ${JSON.stringify(initial.data).slice(0,1000)}`);
  let state=initial.data;
  // The test keystore is process-local; cached profiles need reauthentication after restart.
  if(state.connection.status!=="connected"||state.sync.blockedBy==="account_unavailable"){
    const connect=await local("/api/online/connect","POST",{expectedRevision:state.revision,accountEpoch:state.accountEpoch}); assert.equal(connect.status,202,JSON.stringify(connect.data));
    const authorization=new URL(connect.data.authorizationUrl),redirect=await fetch(authorization,{redirect:"manual",tls:{ca:cert}}); assert.equal(redirect.status,302);
    assert.equal((await fetch(redirect.headers.get("location")!,{headers:{Cookie:connect.cookie},redirect:"error"})).status,200);
    state=(await local("/api/online/state")).data;
  }
  if(state.consent.status!=="accepted"){
    const consent=await local("/api/online/consent","PUT",{expectedRevision:state.revision,accountEpoch:state.accountEpoch,acceptedPolicyVersions:state.policy.versions}); assert.equal(consent.status,200); state=(await local("/api/online/state")).data;
  }
  if(state.preferencePersistence!=="confirmed"||state.preferences?.visibility!=="public"||state.preferences?.setupUploads!==false){
    const preferences=await local("/api/online/preferences","PUT",{expectedRevision:state.revision,accountEpoch:state.accountEpoch,preferences:{visibility:"public",setupUploads:false}}); assert.equal(preferences.status,200,JSON.stringify(preferences.data)); state=(await local("/api/online/state")).data;
  }
  assert.equal(state.uploadAllowed,true,JSON.stringify(onlineSummary(state))); return state;
}
async function wakeCron(local:ReturnType<typeof localClient>){
  const state=(await local("/api/online/state")).data;
  const res=await local("/api/online/preferences","PUT",{expectedRevision:state.revision,accountEpoch:state.accountEpoch,preferences:{visibility:"public",setupUploads:false}});
  assert.equal(res.status,200,JSON.stringify(res.data));
}
let cloud:Bun.Subprocess|undefined,processor:Bun.Subprocess|undefined,desktop:Bun.Subprocess|undefined;
let cloudDb:Database|undefined;
const outcomes:Record<string,unknown>={};
try{
  const data=join(temporary,"device"); await mkdir(data,{recursive:true});
  const sourceForClone=new Database(join(sourceReal,"app.db"),{readonly:true});
  try { sourceForClone.prepare("VACUUM INTO ?").run(join(data,"app.db")); } finally { sourceForClone.close(); }
  await cp(join(sourceReal,"sessions"),join(data,"sessions"),{recursive:true}); await cp(join(sourceReal,"settings.json"),join(data,"settings.json"));
  const identity=join(sourceReal,"recording-installation-id"); assert.ok(existsSync(identity),"Same-installation source must include recording installation identity"); await cp(identity,join(data,"recording-installation-id"));
  const cloneDb=new Database(join(data,"app.db"));
  try{for(const column of ["raw_file","capture_manifest_file","capture_archive_file"]){for(const row of cloneDb.prepare(`SELECT id,${column} AS path FROM sessions WHERE ${column} IS NOT NULL`).all()){
    const canonical=await realpath(row.path); assert.ok(canonical.startsWith(`${sourceReal}${sep}`)); cloneDb.prepare(`UPDATE sessions SET ${column}=? WHERE id=?`).run(join(data,relative(sourceReal,canonical)),row.id);
  }}}finally{cloneDb.close();}
  const dbPath=join(data,"app.db"),mutator=new Database(dbPath);
  const initialWinners=[...best.values()];
  const f1=initialWinners.find(row=>row.gameId==="f1-2025")!,lmu=initialWinners.find(row=>row.gameId==="lmu")!;
  const f1Source=mutator.prepare<{artifact:string|null}>(`SELECT COALESCE(s.capture_archive_file,s.capture_manifest_file,s.raw_file) AS artifact FROM sessions s JOIN laps l ON l.session_id=s.id WHERE l.id=?`).get(f1.lapId);
  const f1Artifact=f1Source?.artifact;
  let hiddenArtifact:string|undefined;
  if(f1Artifact){hiddenArtifact=`${f1Artifact}.held`; await cp(f1Artifact,hiddenArtifact); await rm(f1Artifact);}
  mutator.close();
  cloud=start([join(cloudRoot!,"apps/raceiq/target/debug/raceiq-server")],cloudRoot!,{...storage,HOST:"127.0.0.1",PORT:String(apiPort),HTTP_METRICS_HOST:"127.0.0.1",HTTP_METRICS_PORT:"0",PUBLIC_BASE_URL:apiBase,SUPABASE_URL:providerBase,SUPABASE_PUBLISHABLE_KEY:"r03-local-key",PUBLIC_API_RATE_LIMIT_PER_MINUTE:"60000",PUBLIC_API_RATE_LIMIT_BURST:"10000",PUBLIC_API_TRUSTED_PROXY_IPS:""});
  await ready(`${apiBase}/healthz`);
  processor=start(["bun","--no-env-file","apps/lap-processor/src/main.ts"],cloudRoot!,{...storage,LAP_PROCESSOR_METRICS_HOST:"127.0.0.1",LAP_PROCESSOR_METRICS_PORT:String(metricsPort),RETENTION_MODE:"enabled"});
  cloudDb=new Database(storage.SQLITE_PATH,{readonly:true});
  desktop=start(["bun","--no-env-file","apps/backend/src/index.ts"],desktopRoot,{NODE_ENV:"test",DATA_DIR:data,SERVER_HOST:"127.0.0.1",SERVER_PORT:String(appPort),UDP_PORT:String(udpPort),RACEIQ_DEV_UDP_PORT:String(udpPort),RACEIQ_E2E:"1",RACEIQ_E2E_ONLINE_ORIGIN:proxyBase,RACEIQ_E2E_AUTH_ORIGIN:authOrigin,RACEIQ_E2E_AUTH_PUBLISHABLE_KEY:"lifecycle-local-key",NODE_EXTRA_CA_CERTS:certFile!,RACEIQ_DISABLE_TRAY:"1",RACEIQ_LAUNCHER_OPENS_BROWSER:"0"});
  await ready(`${appBase}/api/auth/status`);
  const local=localClient(); if((await local("/api/auth/status")).data.pending)assert.equal((await local("/api/auth/setup","POST",{password:"RaceIQ-lifecycle-local-2026",exposureConfirmed:true})).status,200);
  assert.equal((await local("/api/auth/login","POST",{password:"RaceIQ-lifecycle-local-2026"})).status,200);
  await ensureOnline(local);
  const currentDb=new Database(dbPath,{readonly:true});
  let winnerRows:Array<{lapId:number;guid:string;gameId:string;result:string|null;blocked:string|null;remoteJobId:string|null}>;
  try{winnerRows=currentDb.prepare(`SELECT l.id AS lapId,l.lap_guid AS guid,s.game_id AS gameId,l.online_upload_result AS result,l.online_upload_blocked_reason AS blocked,l.online_remote_job_id AS remoteJobId FROM online_fastest_combo_laps w JOIN laps l ON l.id=w.lap_id JOIN sessions s ON s.id=l.session_id WHERE s.game_id IN ('f1-2025','lmu') ORDER BY s.game_id`).all();}
  finally{currentDb.close();}
  assert.ok(winnerRows.some(row=>row.guid===f1.guid)&&winnerRows.some(row=>row.guid===lmu.guid),"Current winner table must contain genuine F1+LMU source rows");
  await wakeCron(local);
  const firstResults=await Promise.race([heldBody.promise,Bun.sleep(90_000).then(()=>{throw new Error("No genuine multipart request reached held transport");})]);
  assert.equal(firstResults,lmu.guid,"Unavailable F1 source must be skipped and LMU must progress");
  assert.equal(activeBodies,1,"Held multipart request must remain active");
  assert.equal(maximumActiveBodies,1);
  await wakeCron(local); await Bun.sleep(500);
  assert.equal(activeBodies,1,"Another wake must not release or overlap held upload");
  assert.equal(maximumActiveBodies,1,"Cron wake during held request must not overlap global upload");
  releaseBody.resolve();
  const waitUntil=async(predicate:()=>boolean,label:string)=>{const until=Date.now()+180_000;while(Date.now()<until){if(predicate())return;await Bun.sleep(250);}assert.fail(`Timed out: ${label}`);};
  const readRows=()=>{const db=new Database(dbPath,{readonly:true});try{return db.prepare(`SELECT l.id AS lapId,l.lap_guid AS guid,s.game_id AS gameId,l.online_upload_result AS result,l.online_upload_blocked_reason AS blocked,l.online_remote_job_id AS remoteJobId,l.online_uploaded_at AS uploadedAt FROM online_fastest_combo_laps w JOIN laps l ON l.id=w.lap_id JOIN sessions s ON s.id=l.session_id WHERE s.game_id IN ('f1-2025','lmu') ORDER BY s.game_id`).all();}finally{db.close();}};
  await waitUntil(()=>readRows().some(row=>row.guid===lmu.guid&&row.result==="success"&&row.remoteJobId),"LMU confirmed receipt");
  const stateAfterMissing=(await local("/api/online/state")).data;
  const uploadsState=await local(`/api/online/uploads?view=queue&accountEpoch=${encodeURIComponent(stateAfterMissing.accountEpoch)}&expectedRevision=${stateAfterMissing.revision}&limit=100`);
  assert.equal(uploadsState.status,200,JSON.stringify(uploadsState.data));
  const f1Status=uploadsState.data.items.find((item:{lapGuid?:string})=>item.lapGuid===f1.guid);
  assert.ok(f1Status,"Unavailable F1 winner remains truthfully awaiting");
  assert.equal(f1Status.delivery,"awaiting","Unavailable source remains waiting rather than fabricated success");
  const unavailableRow=readRows().find(row=>row.guid===f1.guid);
  assert.ok(unavailableRow&&unavailableRow.result===null&&unavailableRow.blocked===null,"Temporary source unavailability remains nonterminal without durable blocked state");
  if(f1Artifact&&hiddenArtifact){await cp(hiddenArtifact,f1Artifact);await rm(hiddenArtifact);}
  await wakeCron(local);
  await waitUntil(()=>readRows().some(row=>row.guid===f1.guid&&row.result==="success"&&row.remoteJobId),"F1 upload after source restore");
  const finalRows=readRows();
  for(const winner of [f1,lmu]){const receipt=finalRows.find(row=>row.guid===winner.guid);assert.ok(receipt&&receipt.result==="success"&&receipt.remoteJobId&&receipt.uploadedAt,`Confirmed receipt persists on lap ${winner.lapId}`);}
  const bodyCount=multipartGuids.length; await wakeCron(local); await Bun.sleep(1_000); assert.equal(multipartGuids.length,bodyCount,"Terminal rows must not resubmit on later pass");
  const beforeRestart=bodyCount; await stop(desktop); desktop=undefined;
  desktop=start(["bun","--no-env-file","apps/backend/src/index.ts"],desktopRoot,{NODE_ENV:"test",DATA_DIR:data,SERVER_HOST:"127.0.0.1",SERVER_PORT:String(appPort),UDP_PORT:String(udpPort),RACEIQ_DEV_UDP_PORT:String(udpPort),RACEIQ_E2E:"1",RACEIQ_E2E_ONLINE_ORIGIN:proxyBase,RACEIQ_E2E_AUTH_ORIGIN:authOrigin,RACEIQ_E2E_AUTH_PUBLISHABLE_KEY:"lifecycle-local-key",NODE_EXTRA_CA_CERTS:certFile!,RACEIQ_DISABLE_TRAY:"1",RACEIQ_LAUNCHER_OPENS_BROWSER:"0"});
  await ready(`${appBase}/api/auth/status`); const resumed=localClient(); assert.equal((await resumed("/api/auth/login","POST",{password:"RaceIQ-lifecycle-local-2026"})).status,200); await ensureOnline(resumed); await wakeCron(resumed); await Bun.sleep(2_000); assert.equal(multipartGuids.length,beforeRestart,"Restart must not resubmit terminal rows");
  assert.equal(profileWrites,0,"Profile write endpoints must not be called");
  assert.equal(maximumActiveBodies,1,"At most one global multipart request active");
  outcomes.E03={passed:true,winners:[f1.guid,lmu.guid],multipartGuids,maximumActiveBodies,receipts:finalRows.map(row=>({lapId:row.lapId,guid:row.guid,result:row.result,remoteJobId:row.remoteJobId,uploadedAt:row.uploadedAt}))};
  outcomes.E07={passed:true,f1UnavailableSkipped:true,lmuProgressedWhileUnavailable:true,f1RestoredAndUploaded:true,repairOrHistoryScan:false};
  outcomes.E10={passed:true,profileWrites}; outcomes.E11={passed:true,status:{waiting:f1Status.delivery??"awaiting",temporaryUnavailable:"transient; no persisted block",success:"confirmed receipt"}};
  outcomes.E12={passed:true,terminalRowsNotResubmitted:true,restartNotResubmitted:true};
  outcomes.notCovered={E05:"No native ingress/control barrier for genuine faster B/C finalizations; synthetic times prohibited.",E06:"Delete-before-send and in-flight deletion not covered by this fixture revision.",E13:"Community import/replay belongs to online-user-journeys fixture; no replay claim here.",hostedTerminalRejection:"Not covered: isolated service fixture lacks deterministic real ownership-conflict seed; proxy response is not hosted validation proof.",durableCredentialRestore:"The isolated test keystore is process-local; restart coverage reauthenticates instead of proving OS-keystore persistence."};
  console.log(JSON.stringify({scenario:"online-upload-lifecycle",passed:true,outcomes,evidenceDirectory:temporary}));
}catch(error){
  const evidence=join(temporary,"child-logs"); await Bun.write(join(temporary,"failure.json"),JSON.stringify({error:error instanceof Error?error.message:String(error)}));
  await mkdir(evidence,{recursive:true}); for(const [child,log] of logs)if(log.trim())await Bun.write(join(evidence,`child-${child.pid}.log`),log.slice(-20_000));
  console.error(JSON.stringify({passed:false,error:error instanceof Error?error.message:String(error),evidenceDirectory:temporary})); throw error;
}finally{
  releaseBody.resolve(); await stop(desktop);await stop(processor);await stop(cloud);cloudDb?.close();proxy.stop(true);tlsProvider.stop(true);plainProvider.stop(true);
}
