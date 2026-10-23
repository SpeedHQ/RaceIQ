import { createHash } from "node:crypto";
import type { GameIdentityBinding,OnlineError } from "../contracts/index";

export const UPLOAD_GAME_IDS = ["acc", "ac-evo", "f1-2025", "iracing", "lmu"] as const;
export const MAX_ONLINE_UPLOAD_BYTES=500_000_000;
export const MAX_ONLINE_SETUP_BYTES=1_048_576;

/** Only named public failures cross the source/Online boundary; never parser errors or paths. */
export function getOnlineRecordingError(cause:unknown):OnlineError {
  const code=cause instanceof Error&&"code"in cause?cause.code:null;
  const retryAfter=cause instanceof Error&&"retryAfter"in cause&&typeof cause.retryAfter==="string"&&Number.isFinite(Date.parse(cause.retryAfter))?cause.retryAfter:null;
  switch(code){
    case "unsupported_recording_format":case "f1_sanitization_failed":case "recording_too_large":
    case "unsupported_game":case "ineligible_lap":
    case "driver_identity_required":case "mixed_driver_lap":case "activity_identity_ambiguous":
    case "activity_owner_conflict":case "lap_identity_conflict":case "not_connected":
    case "policy_changed":case "consent_required":
      return {code,retryable:false,retryAfter:null};
    case "recording_not_ready":case "stale_state":case "offline":case "service_unavailable":
    case "policy_unavailable":case "rate_limited":
      return {code,retryable:true,retryAfter};
    case "source_context_unavailable":return {code:"driver_identity_required",retryable:false,retryAfter:null};
    default:return {code:"service_unavailable",retryable:true,retryAfter:null};
  }
}

export type UploadGame = (typeof UPLOAD_GAME_IDS)[number];
export type PayloadBlockReason="unsupported_recording_format"|"f1_sanitization_failed"|"recording_too_large";
export type PayloadGateResult =
  | { readonly ok: true; readonly recording: Uint8Array<ArrayBuffer>; readonly setup: Uint8Array<ArrayBuffer> | null; readonly filename: string }
  | { readonly ok: false; readonly reason: PayloadBlockReason };

/**
 * Implementations may be supplied only after the exact format is verified
 * against both the published upload contract and the service parser. The
 * repository's local capture parser alone is not sufficient evidence.
 */
export interface VerifiedRecordingCodec {
  readonly recordingFormatId: string;
  supportsSetupAttachment(gameId: UploadGame): boolean;
  isServiceCompatible(recording: Uint8Array,gameId:UploadGame):boolean|Promise<boolean>;
  stripF1SetupTelemetry(recording:Uint8Array):Uint8Array|null|Promise<Uint8Array|null>;
  hasF1SetupTelemetry(recording:Uint8Array):boolean|Promise<boolean>;
}

export interface OnlineLapIdentity {
  lapGuid: string;
  originalActivityId: string;
  sourceRevision: string;
  sourceKind: "native_capture" | "verified_portable";
  ownerUserId: string;
  driverBindingId: string;
  driverBindingRevision: number;
}
export interface RegisteredOnlineDriverBinding {id:string;revision:number}
export interface OnlineRecordingProducerOptions {
  resolveDriverBinding(captured:GameIdentityBinding):Promise<RegisteredOnlineDriverBinding>;
}
/** Prepared bytes are supplied by the per-lap recording producer, never a session slicer. */
export interface PreparedOnlineLapUpload extends OnlineLapIdentity {
  gameId: UploadGame;
  trackId: string;
  carId: string;
  lapId: number;
  lapTimeMs: number;
  recording: Uint8Array<ArrayBuffer>;
  setup: Uint8Array<ArrayBuffer> | null;
  filename: string;
  fingerprint: string;
  codec: VerifiedRecordingCodec;
  /** Ephemeral source snapshot check; never persisted with immutable payload bytes. */
  isSourceCurrent(): Promise<boolean>;
}

export async function uploadPayloadFingerprint(recording:Uint8Array,setup:Uint8Array|null):Promise<string> {
  const hash = createHash("sha256");
  const length = Buffer.allocUnsafe(8);
  hash.update("raceiq-online-upload-payload-v1\0");
  length.writeBigUInt64LE(BigInt(recording.byteLength));
  hash.update(length);
  for(let offset=0;offset<recording.byteLength;offset+=1024*1024){
    await Bun.sleep(0);
    hash.update(recording.subarray(offset,offset+1024*1024));
  }
  hash.update(setup === null ? "\x00" : "\x01");
  if (setup !== null) {
    length.writeBigUInt64LE(BigInt(setup.byteLength));
    hash.update(length);
    for(let offset=0;offset<setup.byteLength;offset+=1024*1024){
      await Bun.sleep(0);
      hash.update(setup.subarray(offset,offset+1024*1024));
    }
  }
  return hash.digest("hex");
}

export type UploadPayloadInput = {
  readonly gameId: UploadGame;
  readonly recording: Uint8Array;
  readonly filename: string;
  readonly setupAttachment: Uint8Array | null;
  readonly setupUploadsAllowed: boolean;
  readonly codec: VerifiedRecordingCodec | null;
};

/** Copies accepted bytes; sanitizer receives a copy, never caller-owned recording bytes. */
export async function prepareUploadPayload(input:UploadPayloadInput):Promise<PayloadGateResult> {
  const isF1 = input.gameId === "f1-2025";
  const blockedReason = isF1 ? "f1_sanitization_failed" : "unsupported_recording_format";
  let invalidFilename = !input.filename || input.filename === "." || input.filename === "..";
  if (!invalidFilename) {
    for (const character of input.filename) {
      const code = character.charCodeAt(0);
      if (character === "/" || character === "\\" || code <= 31 || code === 127) {
        invalidFilename = true;
        break;
      }
    }
  }
  if (!UPLOAD_GAME_IDS.includes(input.gameId as UploadGame) ||
      !(input.recording instanceof Uint8Array) || input.recording.byteLength === 0 ||
      invalidFilename) {
    return { ok: false, reason: blockedReason };
  }
  if(input.recording.byteLength>MAX_ONLINE_UPLOAD_BYTES)return {ok:false,reason:"recording_too_large"};
  const codec = input.codec;
  if (!codec || !codec.recordingFormatId) return { ok: false, reason: blockedReason };

  const sourceCopy = new Uint8Array(input.recording);
  try {
    let recording: Uint8Array<ArrayBuffer>;
    if (isF1&&await codec.hasF1SetupTelemetry(sourceCopy)) {
      const sanitized = await codec.stripF1SetupTelemetry(sourceCopy);
      if (!sanitized || sanitized.buffer === input.recording.buffer ||
          await codec.hasF1SetupTelemetry(sanitized) || !await codec.isServiceCompatible(sanitized,input.gameId)) {
        return { ok: false, reason: "f1_sanitization_failed" };
      }
      recording=sanitized.buffer instanceof ArrayBuffer?sanitized as Uint8Array<ArrayBuffer>:new Uint8Array(sanitized);
    } else {
      if (!await codec.isServiceCompatible(sourceCopy,input.gameId)) return {ok:false,reason:blockedReason};
      recording = sourceCopy;
    }

    let setup: Uint8Array<ArrayBuffer> | null = null;
    if (input.setupUploadsAllowed && input.setupAttachment) {
      try {
        if (codec.supportsSetupAttachment(input.gameId)) setup = new Uint8Array(input.setupAttachment);
      } catch {
        // Unsupported/unknown attachment capability omits optional bytes.
      }
    }
    return { ok: true, recording, setup, filename: input.filename };
  } catch {
    return { ok: false, reason: blockedReason };
  }
}
