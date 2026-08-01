import { createHash } from "crypto";
import { gunzip } from "zlib";
import { promisify } from "util";

const gunzipAsync = promisify(gunzip);

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

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function loadRawCaptureIdentity(path: string): Promise<RawCaptureIdentity | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const stored = Buffer.from(await file.arrayBuffer());
  const storageEncoding = isGzip(stored) ? "gzip" : "identity";
  const bytes =
    storageEncoding === "gzip"
      ? Buffer.from(await gunzipAsync(stored))
      : stored;
  return {
    bytes,
    contentHash: sha256ContentHash(bytes),
    storageEncoding,
  };
}
