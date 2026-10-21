export type CloudLapImportStatus =
  | "idle"
  | "awaiting_sign_in"
  | "downloading"
  | "validating"
  | "registering"
  | "complete"
  | "error";
export interface CloudLapImportAccessContext { accountEpoch:string;expectedRevision:number }
export interface CloudLapImportSelection { gameId:string;trackId:string;carId:string }

export interface CloudLapImportState {
  status: CloudLapImportStatus;
  lapId: string | null;
  localLap: { id: number; gameId: string; sessionId: number } | null;
  error: { code: string; retryable: boolean } | null;
  activationId: number | null;
  access:CloudLapImportAccessContext|null;
  lapGuid:string|null;
  selection:CloudLapImportSelection|null;
}

export const IDLE_CLOUD_LAP_IMPORT: CloudLapImportState = {
  status: "idle",
  lapId: null,
  localLap: null,
  error: null,
  activationId: null,
  access:null,
  lapGuid:null,
  selection:null,
};
