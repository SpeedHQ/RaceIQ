import { Worker } from "node:worker_threads";
import { IS_COMPILED } from "@raceiq/backend-core/runtime/config/paths";
import { getSecret, setSecret } from "@raceiq/backend-core/runtime/platform/keystore";
import { subscribeOnlineSync } from "@raceiq/online/server/sync-events";
import { OnlineWorkerUnavailable,type HostRequest,type WorkerRequest,type WorkerResponse,type OnlineWorkerPort,type WorkerMethod,type NativeBindingHostControl,type OnlineWorkerData } from "@raceiq/online/server/worker-protocol";
import { resolveOnlinePlatform } from "./online-platform";
import { client } from "@raceiq/backend-core/db/index";
import { createDatabaseWriteLeaseAuthority, type WriteLeaseRequest } from "@raceiq/backend-core/db/write-coordination";
import { isSessionSourceMutationActive } from "@raceiq/backend-core/session-capture/source-mutation-activity";

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let workerExit: Promise<void> | null = null;
let stopping = false;
let available=false;
let stopPromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeNative:(()=>void)|null=null;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

function rejectPending(): void {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new OnlineWorkerUnavailable()); }
  pending.clear();
}
function request<K extends WorkerMethod>(method: K, ...args: Parameters<OnlineWorkerPort[K]>): ReturnType<OnlineWorkerPort[K]> {
  const result = (async () => {
    if (!worker || !ready || (stopping && method !== "stop")) throw new OnlineWorkerUnavailable();
    await ready;
    const active = worker;
    if (!active || (stopping && method !== "stop")) throw new OnlineWorkerUnavailable();
    if(!available&&method!=="stop")throw new OnlineWorkerUnavailable();
    const {promise,resolve,reject}=Promise.withResolvers<unknown>();
    const requestId=crypto.randomUUID();
    const timeout=method==="stop"?5_000:method==="completeDashboardSignIn"?45_000:30_000;
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new OnlineWorkerUnavailable());},timeout);
    pending.set(requestId,{resolve,reject,timer});
    try { active.postMessage({type:"request",requestId,method,args} as WorkerRequest); }
    catch { pending.delete(requestId); clearTimeout(timer); reject(new OnlineWorkerUnavailable()); }
    return promise;
  })();
  // The single private channel is implemented by the exhaustive worker dispatcher.
  return result as ReturnType<OnlineWorkerPort[K]>;
}
const port: OnlineWorkerPort = {
  getState: () => request("getState"),
  beginDashboardSignIn: (input) => request("beginDashboardSignIn", input),
  completeDashboardSignIn: (input) => request("completeDashboardSignIn", input),
  consumeDashboardSignIn: (input) => request("consumeDashboardSignIn", input),
  cancelDashboardSignIn: (input) => request("cancelDashboardSignIn", input),
  connect: (input) => request("connect", input),
  cancelSignIn: (input) => request("cancelSignIn", input),
  acceptConsent: (input) => request("acceptConsent", input),
  setPreferences: (input) => request("setPreferences", input),
  setDisplayName: (input) => request("setDisplayName", input),
  signOut: (input) => request("signOut", input),
  getLeaderboard: (input) => request("getLeaderboard", input),
  handleAuthCallback: (url) => request("handleAuthCallback", url),
  getCommunityEntitlement: () => request("getCommunityEntitlement"),
  isCommunityEntitlementCurrent: (entitlement) => request("isCommunityEntitlementCurrent", entitlement),
  getDriverBindings: () => request("getDriverBindings"),
  setDriverBinding: (input) => request("setDriverBinding", input),
  getUploads: (input) => request("getUploads", input),
  getOnlineProfile: () => request("getOnlineProfile"),
  getLocalSummary: (input) => request("getLocalSummary", input),
  importRequest: (input) => request("importRequest", input),
  dispatchCloudLapImport: (url) => request("dispatchCloudLapImport", url),
  wake: () => request("wake"),
  stop: stopOnlineWorker,
};

/** Returns only a typed proxy; never opens a main-thread Online store or service. */
export function getOnlineService(): OnlineWorkerPort { return port; }

/** Call only after the main application migration/recovery boundary has completed. */
export async function startOnlineWorker(nativeBindings:NativeBindingHostControl): Promise<{ stop(): Promise<void> }> {
  const platform=resolveOnlinePlatform();
  if (worker) { await ready; if(!available)throw new OnlineWorkerUnavailable(); return { stop: stopOnlineWorker }; }
  stopping = false;
  stopPromise = null;
  const keystore=platform.kind==="local"?platform.keystore:platform.kind==="production"?{getSecret,setSecret}:{getSecret:async()=>{throw new Error("online_disabled");},setSecret:async()=>{throw new Error("online_disabled");}};
  const active=new Worker(IS_COMPILED?"./apps/backend/src/runtime/online-worker-entry.ts":new URL("../runtime/online-worker-entry.ts",import.meta.url),
    {workerData:{nativeSourceRevisionBuffer:nativeBindings.sourceRevisionBuffer} satisfies OnlineWorkerData});
  worker = active;
  let exited = false;
  const authority = createDatabaseWriteLeaseAuthority((message) => { if (!exited) active.postMessage(message); }, client);
  const cleanup = Promise.withResolvers<void>();
  workerExit = cleanup.promise;
  void workerExit.catch((cause) => console.error("[OnlineWorker] Parent SQL cleanup failed:", cause));
  const initialized=Promise.withResolvers<void>();
  ready=initialized.promise;
  const {resolve,reject}=initialized;
  const terminate = () => { void active.terminate().catch((cause) => console.error("[OnlineWorker] Termination failed:", cause)); };
  const timer=setTimeout(()=>{available=false;reject(new OnlineWorkerUnavailable());terminate();},30_000);
    active.on("message", (message:WorkerResponse|HostRequest|{type:"ready"}|{type:"fatal"}|WriteLeaseRequest) => {
      if (active !== worker) return;
      if (message.type.startsWith("write-lease-")) { authority.receive(message as WriteLeaseRequest); return; }
      if (message.type === "ready") { available=true;clearTimeout(timer);resolve();return; }
      if(message.type==="fatal"){available=false;reject(new OnlineWorkerUnavailable());rejectPending();terminate();return;}
      if (message.type === "host") {
        void (async () => {
          try {
            let value:unknown;
            switch(message.method){
              case "getSecret":
                if(message.args[0]!=="raceiq-online-refresh")throw new Error("invalid_keystore_key");
                value=await keystore.getSecret(...message.args);break;
              case "setSecret":
                if(message.args[0]!=="raceiq-online-refresh")throw new Error("invalid_keystore_key");
                value=await keystore.setSecret(...message.args);break;
              case "listDriverBindingCandidates":value=nativeBindings.listCandidates();break;
              case "isSessionSourceMutationActive":value=isSessionSourceMutationActive(...message.args);break;
              case "resolveDriverBindingCandidate":value=nativeBindings.resolveCandidate(...message.args);break;
              case "consumeDriverBindingCandidate":value=nativeBindings.consumeCandidate(...message.args);break;
            }
            if (!exited && worker === active) active.postMessage({ type: "host-response", requestId: message.requestId, ok: true, value });
          } catch { if (!exited && worker === active) active.postMessage({ type: "host-response", requestId: message.requestId, ok: false }); }
        })().catch((cause) => console.error("[OnlineWorker] Host response failed:", cause));
        return;
      }
      if (message.type !== "response") return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId); clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(Object.assign(new Error(message.error.code), message.error, { status: message.status }));
    });
    const unavailable = () => {
      clearTimeout(timer);
      reject(new OnlineWorkerUnavailable());
      if (worker === active) { available=false;unsubscribe?.(); unsubscribe = null;unsubscribeNative?.();unsubscribeNative=null;rejectPending(); }
    };
    active.on("error", (cause:Error) => {
      const details:string[]=[];
      let current:unknown=cause;
      for(let depth=0;depth<3&&current;depth++){
        if(!(current instanceof Error))break;
        details.push(`${current.name}${"code"in current?` code=${String(current.code)}`:""}: ${current.message}`);
        if(depth===0&&current.stack)details.push(...current.stack.split("\n").slice(0,8));
        current=current.cause;
      }
      console.error(`[DEBUG-online-startup] ${details.join("\n").slice(0,4000)}`);
      unavailable(); terminate();
    });
    active.on("exit",()=>{
      exited = true;
      unavailable();
      void authority.workerExited().finally(()=>{
        if(worker===active){worker=null;ready=null;workerExit=null;}
      }).then(cleanup.resolve,cleanup.reject);
    });
  try{
    await ready;
    if (stopping || worker !== active) throw new OnlineWorkerUnavailable();
    unsubscribe=subscribeOnlineSync(wakeOnlineWorker);
    unsubscribeNative=nativeBindings.subscribeChanges(sourceRevision=>{if(worker===active&&!stopping)active.postMessage({type:"native-bindings-changed",sourceRevision});});
    active.postMessage({type:"native-bindings-changed",sourceRevision:nativeBindings.listCandidates().sourceRevision});
    return {stop:stopOnlineWorker};
  }catch{
    await stopOnlineWorker();
    throw new OnlineWorkerUnavailable();
  }
}
export function stopOnlineWorker(): Promise<void> {
  if (stopPromise) return stopPromise;
  const wasAvailable = available;
  stopping=true;available=false;
  unsubscribe?.(); unsubscribe = null;
  unsubscribeNative?.();unsubscribeNative=null;
  const active = worker;
  const exit = workerExit;
  stopPromise = (async () => {
    try { if (active && wasAvailable) await request("stop"); }
    finally {
      try { if (active) await active.terminate(); }
      finally { await exit; }
    }
  })();
  return stopPromise;
}
let pendingWake:Promise<void>|null=null;
/** Wake hints are coalesced; durable scans recover missed or unavailable hints. */
export function wakeOnlineWorker():void {
  if(stopping||!available||pendingWake)return;
  pendingWake=port.wake().catch(()=>undefined).finally(()=>{pendingWake=null;});
}
