import { gunzipSync } from "node:zlib";

/** Return whether bytes begin with gzip magic. */
export function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/** Decompress gzip bytes; return other bytes unchanged. */
export function gunzipIfNeeded(data: Buffer): Buffer {
  return isGzip(data) ? gunzipSync(data) : data;
}
