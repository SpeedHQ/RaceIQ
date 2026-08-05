/**
 * Parsers for AC Evo `system\*.table` registries inside content.kspkg.
 *
 * The tables are protobuf wire-format messages (no schema shipped). We decode
 * the wire format generically and map fields by inspection:
 *   - system\tracks.table: repeated Track records with display name, content
 *     folder, country code, region and .track/.scene paths.
 *   - system\cars.table:   repeated Car records with ks_* slug, content
 *     folder, display name and brand.
 * Field-number mapping was determined empirically against game v0.3+; parsing
 * is defensive so new/unknown fields are ignored rather than fatal.
 */

export interface ProtoField {
  num: number;
  wire: number;
  /** wire 2 payload */
  bytes?: Buffer;
  /** wire 0/1/5 payload */
  value?: bigint;
}

function readVarint(buf: Buffer, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = off;
  for (;;) {
    if (pos >= buf.length) throw new Error("varint overruns buffer");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
}

/** Decode one level of protobuf wire format. Throws on malformed input. */
export function decodeProtoMessage(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let off = 0;
  while (off < buf.length) {
    const [tag, afterTag] = readVarint(buf, off);
    const num = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (num === 0) throw new Error(`field number 0 at offset ${off}`);
    off = afterTag;
    switch (wire) {
      case 0: {
        const [v, next] = readVarint(buf, off);
        fields.push({ num, wire, value: v });
        off = next;
        break;
      }
      case 1:
        if (off + 8 > buf.length) throw new Error("fixed64 overruns buffer");
        fields.push({ num, wire, value: buf.readBigUInt64LE(off) });
        off += 8;
        break;
      case 2: {
        const [len, next] = readVarint(buf, off);
        const end = next + Number(len);
        if (end > buf.length) throw new Error("length-delimited field overruns buffer");
        fields.push({ num, wire, bytes: buf.subarray(next, end) });
        off = end;
        break;
      }
      case 5:
        if (off + 4 > buf.length) throw new Error("fixed32 overruns buffer");
        fields.push({ num, wire, value: BigInt(buf.readUInt32LE(off)) });
        off += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire} at offset ${off}`);
    }
  }
  return fields;
}

const printable = (b: Buffer): string | null => {
  if (b.length === 0) return null;
  const s = b.toString("utf8");
  return /^[\x20-\x7e -￿]+$/.test(s) ? s : null;
};

function _strField(fields: ProtoField[], num: number): string | null {
  const f = fields.find((x) => x.num === num && x.wire === 2 && x.bytes);
  return f?.bytes ? printable(f.bytes) : null;
}

/**
 * Record blobs of a table file. Layout (empirical, game v0.3):
 *   file → single field-2 envelope → repeated field-3 entries → field-2 record blob.
 * Each entry may carry extra short wire-2 siblings (e.g. `12 02 "IT"`), so we take
 * the largest wire-2 blob per entry as the record.
 */
export function tableRecords(buf: Buffer): Buffer[] {
  const envelope = decodeProtoMessage(buf).find((f) => f.wire === 2 && f.bytes && f.bytes.length > 0);
  if (!envelope?.bytes) return [];
  const out: Buffer[] = [];
  for (const entry of decodeProtoMessage(envelope.bytes)) {
    if (entry.wire !== 2 || !entry.bytes || entry.bytes.length === 0) continue;
    let entryFields: ProtoField[];
    try {
      entryFields = decodeProtoMessage(entry.bytes);
    } catch {
      continue;
    }
    const rec = entryFields
      .filter((f) => f.wire === 2 && f.bytes && f.bytes.length > 0)
      .sort((a, b) => b.bytes!.length - a.bytes!.length)[0];
    if (rec?.bytes) out.push(rec.bytes);
  }
  return out;
}

export interface AcEvoTrackRecord {
  /** Display name, e.g. "Brands Hatch". */
  name: string;
  /** Folder slug under content\tracks, e.g. "brands_hatch". */
  folder: string;
  /** ISO country code, e.g. "GBR". */
  country: string | null;
  /** Region label, e.g. "Europe". */
  region: string | null;
  fieldDump?: string;
}

export interface AcEvoCarRecord {
  /** Car slug, e.g. "ks_ferrari_296_gt3". */
  slug: string;
  /** Display name, e.g. "296 GT3". */
  name: string;
  /** Brand display name, e.g. "Ferrari". */
  brand: string | null;
  fieldDump?: string;
}

const dumpFields = (fields: ProtoField[]): string =>
  fields
    .map((f) =>
      f.wire === 2
        ? `${f.num}:LEN ${JSON.stringify(printable(f.bytes!) ?? `<${f.bytes!.length} bytes>`)}`
        : `${f.num}:${f.wire === 0 ? "VAR" : f.wire === 1 ? "F64" : "F32"} ${f.value}`,
    )
    .join(" | ");

/** Parse system\tracks.table. Records that fail to decode are skipped. */
export function parseTracksTable(buf: Buffer, debug = false): AcEvoTrackRecord[] {
  const out: AcEvoTrackRecord[] = [];
  for (const rec of tableRecords(buf)) {
    let fields: ProtoField[];
    try {
      fields = decodeProtoMessage(rec);
    } catch {
      continue;
    }
    const strings = fields.filter((f) => f.wire === 2 && f.bytes).map((f) => ({ num: f.num, s: printable(f.bytes!) }));
    const folderField = strings.find((x) => x.s?.startsWith("content\\tracks\\"));
    const name = strings.find((x) => x.s && !x.s.includes("\\") && x.num < (folderField?.num ?? 99))?.s;
    const folder = folderField?.s?.replace(/^content\\tracks\\/, "").split("\\")[0];
    if (!name || !folder) continue;
    const trailing = strings.filter((x) => x.s && !x.s.includes("\\") && x.num > (folderField?.num ?? 0));
    const country = trailing.find((x) => /^[A-Z]{3}$/.test(x.s!))?.s ?? null;
    const region = trailing.find((x) => x.s !== country && /^[A-Za-z ]{3,}$/.test(x.s!))?.s ?? null;
    out.push({ name, folder, country, region, ...(debug ? { fieldDump: dumpFields(fields) } : {}) });
  }
  return out;
}

/** Parse system\cars.table. Records that fail to decode are skipped. */
export function parseCarsTable(buf: Buffer, debug = false): AcEvoCarRecord[] {
  const out: AcEvoCarRecord[] = [];
  for (const rec of tableRecords(buf)) {
    let fields: ProtoField[];
    try {
      fields = decodeProtoMessage(rec);
    } catch {
      continue;
    }
    const strings = fields.filter((f) => f.wire === 2 && f.bytes).map((f) => ({ num: f.num, s: printable(f.bytes!) }));
    const slug = strings.find((x) => x.s && /^ks_[a-z0-9_]+$/.test(x.s))?.s;
    if (!slug) continue;
    const nonPath = strings.filter((x) => x.s && !x.s.includes("\\") && x.s !== slug);
    const name = nonPath[0]?.s ?? null;
    const brand = nonPath[1]?.s ?? null;
    if (!name) continue;
    out.push({ slug, name, brand, ...(debug ? { fieldDump: dumpFields(fields) } : {}) });
  }
  return out;
}
