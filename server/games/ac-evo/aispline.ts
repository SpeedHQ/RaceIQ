/**
 * Reader for AC Evo `.ideal_line.aisplinedata` files — a protobuf-encoded
 * ideal (racing) line spline extracted from `content.kspkg`.
 *
 * Reverse-engineered wire format (no protobuf dependency; a hand-rolled
 * varint/fixed32 reader is enough since we only need three field numbers):
 *
 *   Top level: a single field 1 (tag 0x0a), length-delimited, wrapping the
 *   whole spline — a REPEATED sequence of point records, each field 1
 *   (tag 0x0a) length-delimited. Each point record contains:
 *     field 1 (tag 0x0a) length-delimited sub-message = position:
 *       three fixed32 floats: 0x0d <x:f32LE>, 0x15 <y:f32LE>, 0x1d <z:f32LE>
 *       (x,z = world horizontal plane, y = elevation)
 *     field 2 (tag 0x15, wire type 5 fixed32): a float (width/spacing hint)
 *     field 3 (tag 0x18, wire type 0 varint): the point index (0,1,2,...)
 *   The first record often has only the position sub-message.
 */

export interface AiSplinePoint {
  x: number;
  y: number;
  z: number;
  width?: number;
  index?: number;
}

class Reader {
  constructor(public buf: Buffer, public pos = 0) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  readTag(): { field: number; wireType: number } {
    const tag = this.readVarint();
    return { field: tag >>> 3, wireType: tag & 0x7 };
  }

  readFixed32Float(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  /** Skip a field's value given its wire type (for fields we don't care about). */
  skipValue(wireType: number): void {
    switch (wireType) {
      case 0: // varint
        this.readVarint();
        break;
      case 1: // fixed64
        this.pos += 8;
        break;
      case 2: { // length-delimited
        const len = this.readVarint();
        this.pos += len;
        break;
      }
      case 5: // fixed32
        this.pos += 4;
        break;
      default:
        throw new Error(`aispline: unsupported wire type ${wireType} at offset ${this.pos}`);
    }
  }
}

/** Parse a position sub-message (field 1 of a point record): x,y,z fixed32 floats. */
function parsePosition(buf: Buffer): { x: number; y: number; z: number } {
  const r = new Reader(buf);
  let x = 0, y = 0, z = 0;
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 5) x = r.readFixed32Float();
    else if (field === 2 && wireType === 5) y = r.readFixed32Float();
    else if (field === 3 && wireType === 5) z = r.readFixed32Float();
    else r.skipValue(wireType);
  }
  return { x, y, z };
}

/** Parse a single point record: position sub-message + optional width/index. */
function parsePointRecord(buf: Buffer): AiSplinePoint {
  const r = new Reader(buf);
  let pos: { x: number; y: number; z: number } | null = null;
  let width: number | undefined;
  let index: number | undefined;
  while (!r.eof) {
    const { field, wireType } = r.readTag();
    if (field === 1 && wireType === 2) {
      const len = r.readVarint();
      pos = parsePosition(r.buf.subarray(r.pos, r.pos + len));
      r.pos += len;
    } else if (field === 2 && wireType === 5) {
      width = r.readFixed32Float();
    } else if (field === 3 && wireType === 0) {
      index = r.readVarint();
    } else {
      r.skipValue(wireType);
    }
  }
  if (!pos) throw new Error("aispline: point record missing position");
  return { x: pos.x, y: pos.y, z: pos.z, width, index };
}

/**
 * Parse an `.ideal_line.aisplinedata` buffer into an ordered list of points.
 * Throws on malformed input rather than silently returning a partial result.
 */
export function parseAiSpline(buf: Buffer): AiSplinePoint[] {
  const outer = new Reader(buf);
  const { field, wireType } = outer.readTag();
  if (field !== 1 || wireType !== 2) {
    throw new Error(`aispline: unexpected top-level tag field=${field} wireType=${wireType}`);
  }
  const len = outer.readVarint();
  const body = buf.subarray(outer.pos, outer.pos + len);

  const points: AiSplinePoint[] = [];
  const r = new Reader(body);
  while (!r.eof) {
    const tag = r.readTag();
    if (tag.field !== 1 || tag.wireType !== 2) {
      // Unknown top-level repeated field — skip defensively.
      r.skipValue(tag.wireType);
      continue;
    }
    const recLen = r.readVarint();
    const recBuf = body.subarray(r.pos, r.pos + recLen);
    r.pos += recLen;
    points.push(parsePointRecord(recBuf));
  }
  return points;
}
