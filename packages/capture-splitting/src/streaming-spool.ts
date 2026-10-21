import { randomUUID } from "node:crypto";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export interface StreamingSourcePosition { offset: number; endOffset: number; ordinal: number; }
export interface StreamingPositionSpool {
  append(position: StreamingSourcePosition): void | Promise<void>;
  positions(): AsyncIterable<StreamingSourcePosition>;
  discard(): Promise<void>;
}

/** Internal pre-opened file resource used to avoid filesystem work at handover. */
export interface PreparedPositionFile { readonly path: string; readonly file: FileHandle; }

/** Fixed-RAM coordinate journal; native payload remains in the unpublished gzip stage. */
export async function createStreamingPositionSpool(directory: string, prepared?: PreparedPositionFile): Promise<StreamingPositionSpool> {
  const path = prepared?.path ?? join(directory, `${randomUUID()}.positions`);
  let file: FileHandle;
  if (prepared) file = prepared.file;
  else {
    await mkdir(directory, { recursive: true });
    file = await open(path, "wx");
  }
  const buffer = Buffer.allocUnsafe(24 * 2048);
  let used = 0;
  let count = 0;
  let closed = false;
  let discarded: Promise<void> | null = null;
  const flush = async () => {
    let written = 0;
    while (written < used) {
      const result = await file.write(buffer, written, used - written);
      if (result.bytesWritten === 0) throw new Error("Position journal write made no progress");
      written += result.bytesWritten;
    }
    used = 0;
  };
  return {
    append(position) {
      if (closed || !Number.isSafeInteger(position.offset) || !Number.isSafeInteger(position.endOffset) ||
          !Number.isSafeInteger(position.ordinal) || position.offset < 0 || position.endOffset < position.offset || position.ordinal < 0) throw new Error("Invalid streaming source position");
      buffer.writeDoubleLE(position.offset, used);
      buffer.writeDoubleLE(position.endOffset, used + 8);
      buffer.writeDoubleLE(position.ordinal, used + 16);
      used += 24; count++;
      if (used === buffer.length) return flush();
    },
    async *positions() {
      if (closed) throw new Error("Position journal is closed");
      await flush();
      const reader: FileHandle = await open(path, "r");
      const readBuffer = Buffer.allocUnsafe(24 * 2048);
      try {
        let position = 0;
        const end = count * 24;
        while (position < end) {
          const length = Math.min(readBuffer.length, end - position);
          let read = 0;
          while (read < length) {
            const result = await reader.read(readBuffer, read, length - read, position + read);
            if (result.bytesRead === 0) throw new Error("Truncated streaming position journal");
            read += result.bytesRead;
          }
          for (let at = 0; at < length; at += 24) yield {
            offset: readBuffer.readDoubleLE(at), endOffset: readBuffer.readDoubleLE(at + 8), ordinal: readBuffer.readDoubleLE(at + 16),
          };
          position += length;
        }
      } finally { await reader.close(); }
    },
    discard() {
      if (discarded) return discarded;
      closed = true;
      discarded = (async () => {
        const errors: unknown[] = [];
        try { await file.close(); } catch (error) { errors.push(error); }
        try { await rm(path, { force: true }); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Failed to discard streaming position journal");
      })();
      return discarded;
    },
  };
}
