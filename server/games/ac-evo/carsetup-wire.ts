/**
 * Schema-free protobuf wire decoder for AC EVO `.carsetup` files.
 *
 * Byte spans are absolute offsets into the top-level file buffer so the writer
 * can surgically patch fields without re-encoding untouched bytes.
 */

interface Span {
  tagStart?: number;
  valueStart?: number;
  valueEnd?: number;
}

interface LenSpan extends Span {
  lenStart?: number;
  lenEnd?: number;
}

export type WireField =
  | ({ no: number; type: "varint"; value: string } & Span)
  | ({ no: number; type: "fixed64"; double: number } & Span)
  | ({ no: number; type: "float"; value: number } & Span)
  | ({ no: number; type: "message"; fields: WireField[] } & LenSpan)
  | ({ no: number; type: "string"; value: string } & LenSpan)
  | ({ no: number; type: "bytes"; hex: string; floats: number[] | null } & LenSpan);

export interface CarSetupFile {
  /** Preset identifier string if present (field #9). */
  presetId: string | null;
  /** Full decoded wire tree for inspection and semantic mapping. */
  raw: WireField[];
}

function readVarint(buf: Buffer, pos: number): [bigint, number] | null {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos]!;
    result |= BigInt(b & 0x7f) << shift;
    pos++;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

/** Decode a length-delimited payload of N*4 bytes as packed floats, if plausible. */
function tryFloats(bytes: Buffer): number[] | null {
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const f = bytes.readFloatLE(i);
    if (!Number.isFinite(f) || (f !== 0 && (Math.abs(f) < 1e-20 || Math.abs(f) > 1e12))) return null;
    out.push(f);
  }
  return out;
}

function parseMessage(buf: Buffer, depth = 0, absOffset = 0): WireField[] | null {
  if (depth > 16) return null;
  const fields: WireField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagStart = pos;
    const tag = readVarint(buf, pos);
    if (!tag) return null;
    const no = Number(tag[0] >> 3n);
    const wire = Number(tag[0] & 7n);
    if (no === 0 || no > 10000) return null;
    pos = tag[1];
    if (wire === 0) {
      const valueStart = pos;
      const value = readVarint(buf, pos);
      if (!value) return null;
      pos = value[1];
      fields.push({
        no,
        type: "varint",
        value: value[0].toString(),
        tagStart: absOffset + tagStart,
        valueStart: absOffset + valueStart,
        valueEnd: absOffset + pos,
      });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return null;
      fields.push({
        no,
        type: "fixed64",
        double: buf.readDoubleLE(pos),
        tagStart: absOffset + tagStart,
        valueStart: absOffset + pos,
        valueEnd: absOffset + pos + 8,
      });
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return null;
      fields.push({
        no,
        type: "float",
        value: buf.readFloatLE(pos),
        tagStart: absOffset + tagStart,
        valueStart: absOffset + pos,
        valueEnd: absOffset + pos + 4,
      });
      pos += 4;
    } else if (wire === 2) {
      const lenStart = pos;
      const length = readVarint(buf, pos);
      if (!length) return null;
      const byteLength = Number(length[0]);
      pos = length[1];
      const lenEnd = pos;
      if (pos + byteLength > buf.length) return null;
      const bytes = buf.subarray(pos, pos + byteLength);
      const valueStart = pos;
      pos += byteLength;
      const valueEnd = pos;
      const span: LenSpan = {
        tagStart: absOffset + tagStart,
        lenStart: absOffset + lenStart,
        lenEnd: absOffset + lenEnd,
        valueStart: absOffset + valueStart,
        valueEnd: absOffset + valueEnd,
      };
      const message = byteLength > 0 ? parseMessage(bytes, depth + 1, absOffset + valueStart) : [];
      if (message) {
        fields.push({ no, type: "message", fields: message, ...span });
      } else {
        const stringValue = bytes.toString("utf8");
        if (/^[\x20-\x7e\r\n\t]+$/.test(stringValue)) {
          fields.push({ no, type: "string", value: stringValue, ...span });
        } else {
          fields.push({
            no,
            type: "bytes",
            hex: bytes.toString("hex"),
            floats: tryFloats(Buffer.from(bytes)),
            ...span,
          });
        }
      }
    } else {
      return null;
    }
  }
  return fields;
}

/** Parse a `.carsetup` buffer. Returns null if it is not valid wire format. */
export function parseCarSetup(data: Buffer): CarSetupFile | null {
  const raw = parseMessage(data);
  if (!raw) return null;
  const preset = raw.find(
    (field): field is Extract<WireField, { type: "string" }> => field.no === 9 && field.type === "string",
  );
  return { presetId: preset?.value ?? null, raw };
}
