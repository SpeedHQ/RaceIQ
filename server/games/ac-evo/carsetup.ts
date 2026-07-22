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

/** One human-readable row of a decoded setup (label + display value).
 *  `num`/`min`/`max` are present when the row is a confirmed numeric field with
 *  a real extracted per-car range — the UI draws a range bar (like the AI
 *  analysis result) only for those rows; nothing is invented. */
export interface CarSetupRow {
  label: string;
  value: string;
  num?: number;
  min?: number;
  max?: number;
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
 *  fields whose meaning we haven't confirmed yet).
 *
 *  `guesses` maps a wire-number path (e.g. "#4" or "#2.#1", relative to the
 *  message being rendered) to a provisional human label. Guessed labels are
 *  suffixed with "?" and keep the wire number so the UI never presents an
 *  unverified name as fact. */
function genericRows(
  fields: WireField[],
  prefix: string,
  skip: Set<number> = new Set(),
  guesses: Record<string, string> = {},
  path = "",
): CarSetupRow[] {
  const rows: CarSetupRow[] = [];
  const labelFor = (no: number): string => {
    const p = `${path}#${no}`;
    const g = guesses[p];
    return g ? `${g}? (${p})` : `${prefix}${p}`;
  };
  for (const f of fields) {
    if (skip.has(f.no)) continue;
    if (f.type === "message") {
      rows.push(...genericRows(f.fields, prefix, new Set(), guesses, `${path}#${f.no}.`));
    } else if (f.type === "bytes") {
      rows.push({ label: labelFor(f.no), value: f.floats ? f.floats.map((v) => fmt(+v.toFixed(4))).join(" / ") : `0x${f.hex}` });
    } else if (f.type === "string") {
      rows.push({ label: labelFor(f.no), value: f.value });
    } else {
      const v = num(f);
      if (v != null) rows.push({ label: labelFor(f.no), value: fmt(v) });
    }
  }
  return rows;
}

/** Provisional (UNVERIFIED) field-name guesses, inferred from typical values in
 *  real saves plus the known ACE setup-screen layout. Each rendered with a "?"
 *  suffix by genericRows. To be confirmed/corrected by single-slider save
 *  diffing; anything confirmed should graduate to a real label in
 *  summarizeCarSetup and be removed from here. */
const ALIGNMENT_GUESSES: Record<string, string> = {
  // #3 is Toe (confirmed; promoted to real label in summarizeCarSetup)
  // #4 is NOT Toe (front-only constant, e.g. -0.0138) — leave raw
  "#5": "Caster", // front ~6.4–6.7°; rear ~3.6–3.8 also moves with caster edits; derived twin at #5/#6 tracks camber/toe live
  "#6": "Toe (derived)", // tiny signed radians; tracks toe but computed, not the slider input
  "#7": "Compound", // absent→1 on all corners after a compound change
};
const SPRING_GUESSES: Record<string, string> = {
  "#2.#1": "Bumpstop gap", // small signed metres (-0.023)
  "#2.#2": "Bumpstop rate", // 1000
  "#3.#1": "Packer/travel", // 0.048 m
  "#3.#2": "Packer rate", // 1500
};
const DAMPER_GUESSES: Record<string, string> = {
  "#1": "Bump", // clicks (8)
  "#2": "Bump rate", // 8000
  "#3": "Rebound", // clicks (8)
  "#4": "Rebound rate", // 6000
};
const ELECTRONICS_GUESSES: Record<string, string> = {
  "#1": "TC", // 5→12 when TC set to 12
  "#2": "TC2", // 5→7
  "#3": "ABS", // 5→4
  "#5": "Telemetry laps", // 10→20 when telemetry laps set to 20
};
const BRAKE_GUESSES: Record<string, string> = {
  "#2": "Brake power", // 100 (%) — matches the ACE "Brake power" slider
};
const MECH_GUESSES: Record<string, string> = {
  "#2": "Steering ratio", // GT3: 14→15 alongside a steer-ratio change; F1 default 14
};

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
export function summarizeCarSetup(
  setup: CarSetupFile,
  ranges?: Record<string, { min: number; max: number; step: number } | null> | null,
): CarSetupSection[] {
  const sections: CarSetupSection[] = [];
  const msgs = (no: number) => setup.raw.filter((f): f is Extract<WireField, { type: "message" }> => f.no === no && f.type === "message");
  /** Attach a real extracted per-car range to a numeric row when one exists. */
  const withRange = (row: CarSetupRow, n: number, key: string): CarSetupRow => {
    const r = ranges?.[key];
    return r ? { ...row, num: n, min: r.min, max: r.max } : row;
  };

  // #1 — mechanical/brakes/diff (verified against a Ferrari SF25 "F1 default"
  // save with known slider values, plus the Audi R8 GT3 Evo II saves):
  //   #1.#1 floats[2]  front/rear anti-roll bar stiffness (74000/20000 N/m for
  //                    ARB clicks 8/4; GT3 pair moved when ARBs were changed)
  //   #1.#3.#1 brake bias (55, within extracted 50–65) · #1.#3.#2 brake power (100)
  //   #1.#4 diff: #1 power (0.2) · #2 coast (0.25) · #3 preload (45 Nm)
  const mech = msgs(1)[0];
  if (mech) {
    const rows: CarSetupRow[] = [];
    const skip = new Set<number>();
    const arb = mech.fields.find((f): f is Extract<WireField, { type: "bytes" }> => f.no === 1 && f.type === "bytes");
    if (arb?.floats?.length === 2) {
      rows.push({ label: "Front ARB stiffness", value: `${fmt(arb.floats[0] / 1000)} kN/m` });
      rows.push({ label: "Rear ARB stiffness", value: `${fmt(arb.floats[1] / 1000)} kN/m` });
      skip.add(1);
    }
    const brakeMsg = mech.fields.find((f): f is Extract<WireField, { type: "message" }> => f.no === 3 && f.type === "message");
    const bias = brakeMsg ? num(brakeMsg.fields.find((f) => f.no === 1)) : null;
    if (bias != null) {
      rows.push(withRange({ label: "Brake bias", value: `${fmt(bias)}% front` }, bias, "brakeBias"));
      if (brakeMsg) rows.push(...genericRows(brakeMsg.fields, "Brakes ", new Set([1]), BRAKE_GUESSES));
      skip.add(3);
    }
    const diffMsg = mech.fields.find((f): f is Extract<WireField, { type: "message" }> => f.no === 4 && f.type === "message");
    if (diffMsg) {
      const power = num(diffMsg.fields.find((f) => f.no === 1));
      const coast = num(diffMsg.fields.find((f) => f.no === 2));
      const preload = num(diffMsg.fields.find((f) => f.no === 3));
      if (power != null) rows.push({ label: "Diff power", value: fmt(power) });
      if (coast != null) rows.push({ label: "Diff coast", value: fmt(coast) });
      if (preload != null) rows.push({ label: "Diff preload", value: `${fmt(preload)} Nm` });
      rows.push(...genericRows(diffMsg.fields, "Diff ", new Set([1, 2, 3])));
      skip.add(4);
    }
    rows.push(...genericRows(mech.fields, "", skip, MECH_GUESSES));
    if (rows.length) sections.push({ title: "Mechanical & brakes", rows });
  }

  const springs = msgs(2);
  const dampers = msgs(3);
  const alignment = msgs(4);
  for (let i = 0; i < 4; i++) {
    const rows: CarSetupRow[] = [];
    const align = alignment[i];
    if (align) {
      // Range keys per corner (extraction order FL, FR, RL, RR): pressure is
      // per-wheel; camber/toe ranges are per-axle in setup-ranges.json.
      const pressureKey = ["frontLeftTyrePressure", "frontRightTyrePressure", "rearLeftTyrePressure", "rearRightTyrePressure"][i];
      const axle = i < 2 ? "front" : "rear";
      const pressure = num(align.fields.find((f) => f.no === 1));
      const camber = num(align.fields.find((f) => f.no === 2));
      if (pressure != null) rows.push(withRange({ label: "Tyre pressure", value: `${fmt(pressure)} psi` }, pressure, pressureKey));
      if (camber != null) rows.push(withRange({ label: "Camber", value: `${fmt(camber)}°` }, camber, `${axle}Camber`));
      // #3 — toe, raw slider value (verified: FL 0.1→0.06 matched the toe slider edit)
      const toe = num(align.fields.find((f) => f.no === 3));
      if (toe != null) rows.push(withRange({ label: "Toe", value: fmt(toe) }, toe, `${axle}Toe`));
      rows.push(...genericRows(align.fields, "Alignment ", new Set([1, 2, 3]), ALIGNMENT_GUESSES));
    }
    const spring = springs[i];
    if (spring) {
      const rate = num(spring.fields.find((f) => f.no === 1));
      if (rate != null) rows.push({ label: "Spring rate", value: `${fmt(rate / 1000)} kN/m` });
      rows.push(...genericRows(spring.fields, "Spring ", new Set([1]), SPRING_GUESSES));
    }
    const damper = dampers[i];
    if (damper) rows.push(...genericRows(damper.fields, "Damper ", new Set(), DAMPER_GUESSES));
    if (rows.length) sections.push({ title: CORNER_NAMES[i] ?? `Corner ${i + 1}`, rows });
  }

  // #5 — electronics/assists (TC/ABS-style click values).
  const electronics = msgs(5)[0];
  if (electronics) {
    const rows: CarSetupRow[] = [];
    // #4 — engine map, 0-indexed (verified: UI map 6 stored as 5; absent at default).
    const engineMap = num(electronics.fields.find((f) => f.no === 4));
    if (engineMap != null) rows.push({ label: "Engine map", value: fmt(engineMap + 1) });
    rows.push(...genericRows(electronics.fields, "", new Set(engineMap != null ? [4] : []), ELECTRONICS_GUESSES));
    sections.push({ title: "Electronics", rows });
  }

  // #6 — aero & ride height (verified by slider diffing + F1 default save:
  // front wing 7 / rear wing 14 landed at #4/#5):
  // #2 front ride height, #3 rear ride height, #4 front wing, #5 rear wing
  // (verified: Audi save 55/75/–/4 vs extracted ranges 54–70 / 60–90 / null / 1–6).
  const aero = msgs(6)[0];
  if (aero) {
    const rows: CarSetupRow[] = [];
    const labelled: Array<[number, string, string, string]> = [
      [2, "Front ride height", "frontRideHeight", " mm"],
      [3, "Rear ride height", "rearRideHeight", " mm"],
      [4, "Front wing", "frontWing", ""],
      [5, "Rear wing", "rearWing", ""],
    ];
    const skip = new Set<number>();
    for (const [no, label, key, unit] of labelled) {
      const v = num(aero.fields.find((f) => f.no === no));
      if (v != null) {
        rows.push(withRange({ label, value: `${fmt(v)}${unit}` }, v, key));
        skip.add(no);
      }
    }
    rows.push(...genericRows(aero.fields, "", skip));
    sections.push({ title: "Aero & ride height", rows });
  }

  // #7 — fuel: #7.#1 fuel load in litres (verified twice: 30 within extracted
  // 1–120; F1 slider 14 stored as 14, prior 60). ERS deploy/recharge/heat-charging
  // are NOT persisted in .carsetup (F1 save diff showed no change).
  const fuel = msgs(7)[0];
  if (fuel) {
    const rows: CarSetupRow[] = [];
    const fuelLoad = num(fuel.fields.find((f) => f.no === 1));
    if (fuelLoad != null) rows.push(withRange({ label: "Fuel load", value: `${fmt(fuelLoad)} L` }, fuelLoad, "fuel"));
    rows.push(...genericRows(fuel.fields, "", new Set(fuelLoad != null ? [1] : [])));
    sections.push({ title: "Fuel & strategy", rows });
  }

  return sections.filter((s) => s.rows.length > 0);
}
