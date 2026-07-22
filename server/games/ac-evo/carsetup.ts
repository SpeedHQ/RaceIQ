/**
 * AC EVO `.carsetup` file parser.
 *
 * Files are protobuf wire format (no schema shipped with the game). This
 * module decodes the raw wire structure generically, then maps the known
 * field numbers observed in real files to a structured setup object.
 *
 * Observed layout (Audi R8 LMS GT3 Evo II, Brands Hatch):
 *   #1      msg   fuel/strategy block (fuel load, pit strategy?)
 *   #2 x4   msg   per-corner tyre/spring block (FL, FR, RL, RR)
 *   #3 x4   msg   per-corner damper block
 *   #4 x4   msg   per-corner alignment block (pressure/camber/toe)
 *   #5      msg   brakes/misc
 *   #6      msg   aero (floats + packed bytes)
 *   #7      msg   misc
 *   #9      str   preset id, e.g. "ks_audi_r8_lms_gt3_evo_2_preset_..."
 *   #10     varint flags
 *
 * Field-number → meaning mapping is provisional; keep the generic tree in
 * `raw` so callers (and the AI setup engineer) can inspect everything.
 */
import { readFile } from "fs/promises";

export type WireField =
  | { no: number; type: "varint"; value: string }
  | { no: number; type: "fixed64"; double: number }
  | { no: number; type: "float"; value: number }
  | { no: number; type: "message"; fields: WireField[] }
  | { no: number; type: "string"; value: string }
  | { no: number; type: "bytes"; hex: string; floats: number[] | null };

export interface CarSetupFile {
  /** Preset identifier string if present (field #9). */
  presetId: string | null;
  /** Full decoded wire tree for inspection / prompting. */
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

function parseMessage(buf: Buffer, depth = 0): WireField[] | null {
  if (depth > 16) return null;
  const fields: WireField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return null;
    const no = Number(tag[0] >> 3n);
    const wire = Number(tag[0] & 7n);
    if (no === 0 || no > 10000) return null;
    pos = tag[1];
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) return null;
      fields.push({ no, type: "varint", value: v[0].toString() });
      pos = v[1];
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return null;
      fields.push({ no, type: "fixed64", double: buf.readDoubleLE(pos) });
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return null;
      fields.push({ no, type: "float", value: buf.readFloatLE(pos) });
      pos += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) return null;
      const n = Number(len[0]);
      pos = len[1];
      if (pos + n > buf.length) return null;
      const bytes = buf.subarray(pos, pos + n);
      pos += n;
      const msg = n > 0 ? parseMessage(bytes, depth + 1) : [];
      if (msg) {
        fields.push({ no, type: "message", fields: msg });
      } else {
        const s = bytes.toString("utf8");
        if (/^[\x20-\x7e\r\n\t]+$/.test(s)) {
          fields.push({ no, type: "string", value: s });
        } else {
          fields.push({ no, type: "bytes", hex: bytes.toString("hex"), floats: tryFloats(Buffer.from(bytes)) });
        }
      }
    } else {
      return null; // groups (3/4) unused
    }
  }
  return fields;
}

/** Parse a `.carsetup` buffer. Returns null if it isn't valid wire format. */
export function parseCarSetup(data: Buffer): CarSetupFile | null {
  const raw = parseMessage(data);
  if (!raw) return null;
  const preset = raw.find((f): f is Extract<WireField, { type: "string" }> => f.no === 9 && f.type === "string");
  return { presetId: preset?.value ?? null, raw };
}

/** Read and parse a `.carsetup` file from disk. */
export async function readCarSetupFile(filePath: string): Promise<CarSetupFile | null> {
  try {
    return parseCarSetup(await readFile(filePath));
  } catch {
    return null;
  }
}

/** Render decoded tree as compact text (for AI context / debugging). */
export function formatCarSetup(setup: CarSetupFile, fields = setup.raw, indent = ""): string {
  const lines: string[] = [];
  for (const f of fields) {
    if (f.type === "message") {
      lines.push(`${indent}#${f.no} {`);
      lines.push(formatCarSetup(setup, f.fields, indent + "  "));
      lines.push(`${indent}}`);
    } else if (f.type === "float") {
      lines.push(`${indent}#${f.no} = ${+f.value.toFixed(4)}`);
    } else if (f.type === "fixed64") {
      lines.push(`${indent}#${f.no} = ${f.double}`);
    } else if (f.type === "varint") {
      lines.push(`${indent}#${f.no} = ${f.value}`);
    } else if (f.type === "string") {
      lines.push(`${indent}#${f.no} = ${JSON.stringify(f.value)}`);
    } else {
      lines.push(`${indent}#${f.no} = ${f.floats ? `floats[${f.floats.map((v) => +v.toFixed(4)).join(", ")}]` : `0x${f.hex}`}`);
    }
  }
  return lines.join("\n");
}

/** One human-readable row of a decoded setup (label + display value). */
export interface CarSetupRow {
  label: string;
  value: string;
}

/** A titled group of rows, e.g. "Front left" or "Aero". */
export interface CarSetupSection {
  title: string;
  rows: CarSetupRow[];
}

const CORNER_NAMES = ["Front left", "Front right", "Rear left", "Rear right"] as const;

function num(f: WireField | undefined): number | null {
  if (!f) return null;
  if (f.type === "float") return +f.value.toFixed(4);
  if (f.type === "fixed64") return f.double;
  if (f.type === "varint") return Number(f.value);
  return null;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
}

/** Leaf fields of a message rendered as generic numbered rows (fallback for
 *  fields whose meaning we haven't confirmed yet). */
function genericRows(fields: WireField[], prefix: string, skip: Set<number> = new Set()): CarSetupRow[] {
  const rows: CarSetupRow[] = [];
  for (const f of fields) {
    if (skip.has(f.no)) continue;
    if (f.type === "message") {
      rows.push(...genericRows(f.fields, `${prefix}#${f.no}.`));
    } else if (f.type === "bytes") {
      rows.push({ label: `${prefix}#${f.no}`, value: f.floats ? f.floats.map((v) => fmt(+v.toFixed(4))).join(" / ") : `0x${f.hex}` });
    } else if (f.type === "string") {
      rows.push({ label: `${prefix}#${f.no}`, value: f.value });
    } else {
      const v = num(f);
      if (v != null) rows.push({ label: `${prefix}#${f.no}`, value: fmt(v) });
    }
  }
  return rows;
}

/**
 * Map the decoded wire tree to labelled, human-readable sections for the UI.
 *
 * Only field numbers we're confident about (per the observed layout in the
 * module header) get friendly labels — tyre pressure/camber from the #4
 * alignment blocks, spring rate from the #2 corner blocks, fuel from #1.
 * Everything else keeps its wire number so we never mislabel a value; those
 * rows still read better than the raw tree because they're grouped per
 * corner/system.
 */
export function summarizeCarSetup(setup: CarSetupFile): CarSetupSection[] {
  const sections: CarSetupSection[] = [];
  const msgs = (no: number) => setup.raw.filter((f): f is Extract<WireField, { type: "message" }> => f.no === no && f.type === "message");

  const fuel = msgs(1)[0];
  if (fuel) {
    const fuelLoad = num(fuel.fields.find((f) => f.no === 2));
    const rows: CarSetupRow[] = [];
    if (fuelLoad != null) rows.push({ label: "Fuel load", value: `${fmt(fuelLoad)} L` });
    rows.push(...genericRows(fuel.fields, "", new Set([2])));
    sections.push({ title: "Fuel & strategy", rows });
  }

  const springs = msgs(2);
  const dampers = msgs(3);
  const alignment = msgs(4);
  for (let i = 0; i < 4; i++) {
    const rows: CarSetupRow[] = [];
    const align = alignment[i];
    if (align) {
      const pressure = num(align.fields.find((f) => f.no === 1));
      const camber = num(align.fields.find((f) => f.no === 2));
      if (pressure != null) rows.push({ label: "Tyre pressure", value: `${fmt(pressure)} psi` });
      if (camber != null) rows.push({ label: "Camber", value: `${fmt(camber)}°` });
      rows.push(...genericRows(align.fields, "Alignment ", new Set([1, 2])));
    }
    const spring = springs[i];
    if (spring) {
      const rate = num(spring.fields.find((f) => f.no === 1));
      if (rate != null) rows.push({ label: "Spring rate", value: `${fmt(rate / 1000)} kN/m` });
      rows.push(...genericRows(spring.fields, "Spring ", new Set([1])));
    }
    const damper = dampers[i];
    if (damper) rows.push(...genericRows(damper.fields, "Damper "));
    if (rows.length) sections.push({ title: CORNER_NAMES[i] ?? `Corner ${i + 1}`, rows });
  }

  const brakes = msgs(5)[0];
  if (brakes) sections.push({ title: "Brakes / misc", rows: genericRows(brakes.fields, "") });

  const aero = msgs(6)[0];
  if (aero) sections.push({ title: "Aero", rows: genericRows(aero.fields, "") });

  const misc = msgs(7)[0];
  if (misc) sections.push({ title: "Other", rows: genericRows(misc.fields, "") });

  return sections.filter((s) => s.rows.length > 0);
}
