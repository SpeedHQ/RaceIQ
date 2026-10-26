import type { RaceIqOnlinePort,OnlineLocalPort,CommunityEntitlement,DriverSummaryResponse,OnlineError,OnlineKeystore,GameIdentityCandidate } from "../contracts/index";
import type { DashboardRequest } from "@raceiq/shared/racing/sessions/dashboard";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";

export interface DashboardSignInInput { callbackUrl: string }
export interface DashboardSignInAttempt { attemptId: string; authorizationUrl: string; expiresAt: number }
export interface DashboardSignInCompletion { userId: string }
export interface OnlineWorkerPort extends RaceIqOnlinePort, OnlineLocalPort {
  beginDashboardSignIn(input: DashboardSignInInput): Promise<DashboardSignInAttempt>;
  completeDashboardSignIn(input: { attemptId: string; callbackUrl: string }): Promise<DashboardSignInCompletion>;
  consumeDashboardSignIn(input: { attemptId: string }): Promise<DashboardSignInCompletion>;
  cancelDashboardSignIn(input: { attemptId: string }): Promise<void>;
  handleAuthCallback(url: string): Promise<boolean>;
  getCommunityEntitlement(): Promise<CommunityEntitlement>;
  isCommunityEntitlementCurrent(entitlement: Extract<CommunityEntitlement, { allowed: true }>): Promise<boolean>;
  getLocalSummary(input: DashboardRequest): Promise<DriverSummaryResponse>;
  importRequest(input: { path: string; method: "GET" | "POST"; body: string | null; query: string | null; gameId: string | null }): Promise<{ status: 200 | 202 | 400 | 401 | 403 | 409; body: CloudLapImportState }>;
  dispatchCloudLapImport(url: string): Promise<CloudLapImportState>;
  wake(): Promise<void>;
  stop(): Promise<void>;
}
export type WorkerMethod = keyof OnlineWorkerPort;
export type WorkerRequest = { [K in WorkerMethod]: {
  type: "request"; requestId: string; method: K; args: Parameters<OnlineWorkerPort[K]>;
} }[WorkerMethod];
export type WorkerResponse = { type: "response"; requestId: string } & (
  { ok: true; value: unknown } | { ok: false; error: OnlineError | {code:"building";retryable:true;retryAfter:null}; status: number }
);
export interface NativeBindingProof {
  candidateId:string;gameId:string;sourceKind:string;nativeIdentity:string;expiresAt:string;
  bindingRevision:number;sourceRevision:number;
}
export interface NativeBindingCandidateSnapshot {sourceRevision:number;candidates:GameIdentityCandidate[]}
export interface NativeBindingHostControl {
  readonly sourceRevisionBuffer:SharedArrayBuffer;
  listCandidates():NativeBindingCandidateSnapshot;
  resolveCandidate(candidateId:string,expectedBindingRevision:number):NativeBindingProof|null;
  consumeCandidate(candidateId:string,sourceRevision:number):void;
  subscribeChanges(listener:(sourceRevision:number)=>void):()=>void;
}
export interface OnlineWorkerData {nativeSourceRevisionBuffer:SharedArrayBuffer}
export interface OnlineHostPort extends OnlineKeystore {
  isSessionSourceMutationActive(sessionId: number): Promise<boolean>;
  listDriverBindingCandidates():Promise<NativeBindingCandidateSnapshot>;
  resolveDriverBindingCandidate(candidateId:string,expectedBindingRevision:number):Promise<NativeBindingProof|null>;
  consumeDriverBindingCandidate(candidateId:string,sourceRevision:number):Promise<void>;
}
export type HostMethod=keyof OnlineHostPort;
export type HostRequest = {[K in HostMethod]:{type:"host";requestId:string;method:K;args:Parameters<OnlineHostPort[K]>}}[HostMethod];
export type HostResponse = { type: "host-response"; requestId: string } & (
  { ok: true; value: unknown } | { ok: false }
);
export type NativeBindingsChanged = {type:"native-bindings-changed";sourceRevision:number};
export class OnlineWorkerUnavailable extends Error {
  readonly code = "service_unavailable";
  readonly status = 503;
  constructor() { super("Online worker unavailable"); }
}
