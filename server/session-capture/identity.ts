import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
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

/** Hash canonical capture bytes without retaining the file or decompressed stream. */
export async function hashRawCapture(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const input = createReadStream(path);
  const stream = isGzip(prefix) ? input.pipe(createGunzip()) : input;
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
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
