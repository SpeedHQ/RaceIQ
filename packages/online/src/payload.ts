import { createHash } from "node:crypto";

export const UPLOAD_GAME_IDS = ["acc", "ac-evo", "f1-2025", "iracing", "lmu"] as const;

export type UploadGame = (typeof UPLOAD_GAME_IDS)[number];
export type PayloadBlockReason = "unsupported_recording_format" | "f1_sanitization_failed";
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
  isServiceCompatible(recording: Uint8Array, gameId: UploadGame): boolean;
  stripF1SetupTelemetry(recording: Uint8Array): Uint8Array | null;
  hasF1SetupTelemetry(recording: Uint8Array): boolean;
}

/** Prepared bytes are supplied by the per-lap recording producer, never a session slicer. */
export interface PreparedOnlineLapUpload {
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
}

export function uploadPayloadFingerprint(recording: Uint8Array, setup: Uint8Array | null): string {
  const hash = createHash("sha256");
  const length = Buffer.allocUnsafe(8);
  hash.update("raceiq-online-upload-payload-v1\0");
  length.writeBigUInt64LE(BigInt(recording.byteLength));
  hash.update(length);
  hash.update(recording);
  hash.update(setup === null ? "\x00" : "\x01");
  if (setup !== null) {
    length.writeBigUInt64LE(BigInt(setup.byteLength));
    hash.update(length);
    hash.update(setup);
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
export function prepareUploadPayload(input: UploadPayloadInput): PayloadGateResult {
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
  const codec = input.codec;
  if (!codec || !codec.recordingFormatId) return { ok: false, reason: blockedReason };

  const sourceCopy = new Uint8Array(input.recording);
  try {
    let recording: Uint8Array<ArrayBuffer>;
    if (isF1) {
      const sanitized = codec.stripF1SetupTelemetry(sourceCopy);
      if (!sanitized || sanitized.buffer === input.recording.buffer ||
          codec.hasF1SetupTelemetry(sanitized) || !codec.isServiceCompatible(sanitized, input.gameId)) {
        return { ok: false, reason: "f1_sanitization_failed" };
      }
      recording = new Uint8Array(sanitized);
    } else {
      if (!codec.isServiceCompatible(sourceCopy, input.gameId)) return { ok: false, reason: blockedReason };
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
