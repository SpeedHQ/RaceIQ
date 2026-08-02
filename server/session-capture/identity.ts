import { createHash } from "crypto";
import { gunzipBuffer, isGzip } from "./framing";

export interface RawCaptureIdentity {
  bytes: Buffer;
  contentHash: string;
  storageEncoding: "identity" | "gzip";
}

export function rawCaptureObjectId(sessionId: number): string {
  return `session:${sessionId}:raw-capture`;
}

export function sha256ContentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function loadRawCaptureIdentity(path: string): Promise<RawCaptureIdentity | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const stored = Buffer.from(await file.arrayBuffer());
  const storageEncoding = isGzip(stored) ? "gzip" : "identity";
  const bytes =
    storageEncoding === "gzip"
      ? await gunzipBuffer(stored)
      : stored;
  return {
    bytes,
    contentHash: sha256ContentHash(bytes),
    storageEncoding,
  };
}
