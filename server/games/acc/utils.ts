/**
 * ACC utility functions for reading C struct data from buffers.
 */

/** Read a null-terminated UTF-16LE (wchar_t) string from a buffer */
export function readWString(buf: Buffer, offset: number, maxBytes: number): string {
  const slice = buf.slice(offset, offset + maxBytes);
  let end = 0;
  for (let i = 0; i < slice.length - 1; i += 2) {
    if (slice[i] === 0 && slice[i + 1] === 0) break;
    end = i + 2;
  }
  return slice.slice(0, end).toString("utf16le");
}

/** Encode a JS string as null-terminated UTF-16LE for Windows W-suffix APIs */
export function toWideString(str: string): Buffer {
  const buf = Buffer.alloc((str.length + 1) * 2);
  buf.write(str, "utf16le");
  return buf;
}
