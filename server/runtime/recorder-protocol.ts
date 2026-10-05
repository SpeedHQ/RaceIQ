export const RECORDER_PROTOCOL_VERSION = 1;
export const RECORDER_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const RECORDER_MIN_BODY_BYTES = 5;

export const RecorderOpcode = {
  Hello: 1,
  Request: 2,
  Response: 3,
  LiveFrame: 4,
  Event: 5,
  Progress: 6,
  Status: 7,
  Fatal: 8,
} as const;
export type RecorderOpcode = typeof RecorderOpcode[keyof typeof RecorderOpcode];

export type ControlMessage = {
  opcode: Exclude<RecorderOpcode, typeof RecorderOpcode.LiveFrame>;
  requestId: number;
  payload: unknown;
};

export function encodeControlMessage(opcode: RecorderOpcode, requestId: number, payload: unknown): Uint8Array {
  if (!Number.isInteger(requestId) || requestId < 0 || requestId > 0xffff_ffff) throw new RangeError("Invalid recorder request ID");
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const bodyLength = 5 + json.length;
  if (bodyLength > RECORDER_MAX_BODY_BYTES) throw new RangeError("Recorder message exceeds 16 MiB limit");
  const frame = new Uint8Array(4 + bodyLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, bodyLength, true);
  view.setUint8(4, opcode);
  view.setUint32(5, requestId, true);
  frame.set(json, 9);
  return frame;
}

export class RecorderMessageDecoder {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Array<{ opcode: number; requestId: number; payload: Uint8Array }> {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);
    const messages: Array<{ opcode: number; requestId: number; payload: Uint8Array }> = [];
    let offset = 0;
    while (merged.length - offset >= 4) {
      const length = new DataView(merged.buffer, merged.byteOffset + offset, 4).getUint32(0, true);
      if (length < RECORDER_MIN_BODY_BYTES || length > RECORDER_MAX_BODY_BYTES) throw new Error(`Invalid recorder frame length: ${length}`);
      if (merged.length - offset < length + 4) break;
      const body = offset + 4;
      messages.push({
        opcode: merged[body]!,
        requestId: new DataView(merged.buffer, merged.byteOffset + body + 1, 4).getUint32(0, true),
        payload: merged.slice(body + 5, body + length),
      });
      offset += length + 4;
    }
    this.#buffer = merged.slice(offset);
    if (this.#buffer.length > RECORDER_MAX_BODY_BYTES + 4) throw new Error("Recorder frame exceeds 16 MiB limit");
    return messages;
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new Error("Recorder protocol ended with truncated frame");
  }
}
