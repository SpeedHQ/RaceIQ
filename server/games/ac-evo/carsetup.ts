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

/**
 * Byte spans (absolute offsets into the top-level file buffer) recorded
 * during decode so `carsetup-writer.ts` can surgically patch a field's
 * bytes without re-encoding fields it doesn't touch. `tagStart` is where the
 * field's tag varint begins; `valueStart`/`valueEnd` bound the value itself
 * (for scalars) or the length-delimited payload (for message/string/bytes).
 * Length-delimited fields additionally record `lenStart`/`lenEnd`, the span
 * of their own length-prefix varint (`lenEnd === valueStart`). All spans are
 * optional so this stays purely additive — existing decode-only callers that
 * construct/consume `WireField` values without spans are unaffected.
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
      const v = readVarint(buf, pos);
      if (!v) return null;
      pos = v[1];
      fields.push({
        no,
        type: "varint",
        value: v[0].toString(),
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
      const len = readVarint(buf, pos);
      if (!len) return null;
      const n = Number(len[0]);
      pos = len[1];
      const lenEnd = pos;
      if (pos + n > buf.length) return null;
      const bytes = buf.subarray(pos, pos + n);
      const valueStart = pos;
      pos += n;
      const valueEnd = pos;
      const span: LenSpan = {
        tagStart: absOffset + tagStart,
        lenStart: absOffset + lenStart,
        lenEnd: absOffset + lenEnd,
        valueStart: absOffset + valueStart,
        valueEnd: absOffset + valueEnd,
      };
      const msg = n > 0 ? parseMessage(bytes, depth + 1, absOffset + valueStart) : [];
      if (msg) {
        fields.push({ no, type: "message", fields: msg, ...span });
      } else {
        const s = bytes.toString("utf8");
        if (/^[\x20-\x7e\r\n\t]+$/.test(s)) {
          fields.push({ no, type: "string", value: s, ...span });
        } else {
          fields.push({ no, type: "bytes", hex: bytes.toString("hex"), floats: tryFloats(Buffer.from(bytes)), ...span });
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
  /** True when the value is stored in the file but has no in-game slider for
   *  this car (fixed physics parameter) — UI greys it out. */
  fixed?: boolean;
}

/** A titled group of rows, e.g. "Front left" or "Aero". */
export interface CarSetupSection {
  title: string;
  rows: CarSetupRow[];
}

const CORNER_NAMES = ["Front left", "Front right", "Rear left", "Rear right"] as const;

/**
 * Known anti-roll bar click numbers keyed by stiffness in kN/m.
 * Audi R8 LMS GT3 Evo II (Brands Hatch saves): click 1 = min, 3 = max,
 * default 3. Verified: click 1 → 16 kN/m, click 3 → 28 kN/m; click 2 → 22
 * assumed (even 6 kN/m step). Per-car table — extend as more saves are mapped.
 */
export const ARB_CLICK_BY_KNM: Record<number, number> = { 16: 1, 22: 2, 28: 3 };

/**
 * Map an ARB stiffness (kN/m) to a click number, tolerating float noise and
 * small per-car offsets: nearest table key within ±1 kN/m, else null.
 */
export function arbClickFromKnm(kNm: number): number | null {
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const [key, click] of Object.entries(ARB_CLICK_BY_KNM)) {
    const diff = Math.abs(Number(key) - kNm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = click;
    }
  }
  return bestDiff <= 1 ? best : null;
}

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

/** Leaf fields of a message rendered as labelled rows.
 *
 *  `guesses` maps a wire-number path (e.g. "#4" or "#2.#1", relative to the
 *  message being rendered) to a human label (verified via slider diffing).
 *  Fields with no label are omitted from the UI — the raw decode script is
 *  the place to inspect unmapped wire fields. */
/** A guess entry: plain label, or label + `fixed` for values stored in the
 *  file that have no in-game slider (fixed physics params — UI greys them). */
type GuessEntry = string | { label: string; fixed: true };

function genericRows(
  fields: WireField[],
  prefix: string,
  skip: Set<number> = new Set(),
  guesses: Record<string, GuessEntry> = {},
  path = "",
): CarSetupRow[] {
  const rows: CarSetupRow[] = [];
  const guessFor = (no: number): { label: string; fixed?: true } | null => {
    const g = guesses[`${path}#${no}`];
    if (g == null) return null;
    return typeof g === "string" ? { label: g } : g;
  };
  for (const f of fields) {
    if (skip.has(f.no)) continue;
    if (f.type === "message") {
      rows.push(...genericRows(f.fields, prefix, new Set(), guesses, `${path}#${f.no}.`));
      continue;
    }
    const g = guessFor(f.no);
    if (g == null) continue;
    const { label, fixed } = g;
    if (f.type === "bytes") {
      rows.push({ label, value: f.floats ? f.floats.map((v) => fmt(+v.toFixed(4))).join(" / ") : `0x${f.hex}`, fixed });
    } else if (f.type === "string") {
      rows.push({ label, value: f.value, fixed });
    } else {
      const v = num(f);
      if (v != null) rows.push({ label, value: fmt(v), fixed });
    }
  }
  return rows;
}

/** Field-name labels verified (or strongly evidenced) via single-slider save
 *  diffing against real saves plus the known ACE setup-screen layout.
 *  Unlabelled wire fields are hidden from the UI by genericRows. */
const ALIGNMENT_GUESSES: Record<string, string> = {
  // #3 is Toe (confirmed; promoted to real label in summarizeCarSetup)
  // #4 is NOT Toe (front-only constant, e.g. -0.0138) — leave raw
  "#5": "Caster", // front ~6.4–6.7°; rear ~3.6–3.8 also moves with caster edits; derived twin at #5/#6 tracks camber/toe live
  // #6 is a computed twin of toe (tiny signed radians) — hidden in summarizeCarSetup, not shown
  // #7 tyre compound — captured explicitly and shown under Fuel & strategy
};
const SPRING_GUESSES: Record<string, GuessEntry> = {
  // Verified on the Audi R8 GT3 Evo II: in-game FL bumpstop rate 1500 N / range 5
  // clicks matches the #3 block (0.048 m, 1500), so #3 is the adjustable bumpstop
  // and #2 is the fixed packer pair (-0.023, 1000).
  "#2.#1": { label: "Packer range", fixed: true }, // small signed metres (-0.023); no in-game slider
  "#2.#2": { label: "Packer rate", fixed: true }, // 1000; per-car constant, no slider
  "#3.#1": "Bumpstop range", // metres (0.048) behind the in-game clicks slider
  "#3.#2": "Bumpstop rate", // N (1500); adjustable in-game
};
const DAMPER_GUESSES: Record<string, GuessEntry> = {
  "#1": "Slow bump", // clicks (8); matches ACE "Slow bump" slider
  "#2": { label: "Slow bump rate", fixed: true }, // 8000; per-car rate, not a click count
  "#3": "Slow rebound", // clicks (8); matches ACE "Slow rebound" slider
  "#4": { label: "Slow rebound rate", fixed: true }, // 6000; per-car rate, not a click count
};
const ELECTRONICS_GUESSES: Record<string, string> = {
  "#1": "TC", // 5→12 when TC set to 12
  "#2": "TC2", // 5→7
  "#3": "ABS", // 5→4
  "#5": "Telemetry laps", // 10→20 when telemetry laps set to 20
  // ERS (F1) — NOT yet mapped; encoding unclear. Observations (SF25, Brands Hatch):
  //   #8: 3 when UI deploy map 4; absent when UI map 1 (looks 0-indexed) — BUT
  //       switching heat charging deploy→charge also wiped #8 and set #9 40→0.01,
  //       and #11 stayed 2 through the heat-mode change, so #11 is not heat mode.
  //   Heat mode may be encoded implicitly (charge = #8 absent + #9 ≈ 0), or the UI
  //   resets deploy/recharge on mode switch. Needs in-game verification before labeling.
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
    const frontRows: CarSetupRow[] = [];
    const rearRows: CarSetupRow[] = [];
    const rows: CarSetupRow[] = [];
    const skip = new Set<number>();
    // In-game the ARB sliders are plain click values (single digits) — show raw.
    const arb = mech.fields.find((f): f is Extract<WireField, { type: "bytes" }> => f.no === 1 && f.type === "bytes");
    if (arb?.floats?.length === 2) {
      // Values may be plain clicks (single digits) or per-car stiffness in N/m
      // (verified Audi R8 GT3 Evo II front click→stiffness: 1→16, (2→22 assumed),
      // 3→28 kN/m). Range from setup-ranges.json is in clicks, so only attach it
      // when we have a click number.
      const arbRow = (raw: number, key: string): CarSetupRow => {
        if (raw > 100) {
          const kNm = raw / 1000;
          const click = arbClickFromKnm(kNm);
          const row: CarSetupRow = {
            label: "Anti-roll bar",
            value: click != null ? `${click} (${fmt(kNm)} kN/m)` : `${fmt(kNm)} kN/m`,
          };
          return click != null ? withRange(row, click, key) : row;
        }
        return withRange({ label: "Anti-roll bar", value: fmt(raw) }, raw, key);
      };
      frontRows.push(arbRow(arb.floats[0], "frontARB"));
      rearRows.push(arbRow(arb.floats[1], "rearARB"));
      skip.add(1);
    }
    const brakeMsg = mech.fields.find((f): f is Extract<WireField, { type: "message" }> => f.no === 3 && f.type === "message");
    const bias = brakeMsg ? num(brakeMsg.fields.find((f) => f.no === 1)) : null;
    if (bias != null) {
      frontRows.push(withRange({ label: "Brake bias", value: `${fmt(bias)}% front` }, bias, "brakeBias"));
      // Brake power (#3.#2) is a fixed per-car value, not tunable in-game — hide it.
      skip.add(3);
    }
    // #2 — steering ratio (verified: GT3 14→15 alongside a steer-ratio change;
    // F1 default 14) — belongs on the Front card.
    const steer = num(mech.fields.find((f) => f.no === 2));
    if (steer != null) {
      frontRows.push(withRange({ label: "Steer ratio", value: fmt(steer) }, steer, "steerRatio"));
      skip.add(2);
    }
    const diffMsg = mech.fields.find((f): f is Extract<WireField, { type: "message" }> => f.no === 4 && f.type === "message");
    if (diffMsg) {
      const power = num(diffMsg.fields.find((f) => f.no === 1));
      const coast = num(diffMsg.fields.find((f) => f.no === 2));
      const preload = num(diffMsg.fields.find((f) => f.no === 3));
      if (power != null) rows.push({ label: "Diff power", value: fmt(power), fixed: true });
      if (coast != null) rows.push({ label: "Diff coast", value: fmt(coast), fixed: true });
      if (preload != null) rearRows.push(withRange({ label: "Differential preload", value: `${fmt(preload)} Nm` }, preload, "diffPreload"));
      rows.push(...genericRows(diffMsg.fields, "Diff ", new Set([1, 2, 3])));
      skip.add(4);
    }
    rows.push(...genericRows(mech.fields, "", skip, MECH_GUESSES));
    if (frontRows.length) sections.push({ title: "Front", rows: frontRows });
    if (rearRows.length) sections.push({ title: "Rear", rows: rearRows });
    if (rows.length) sections.push({ title: "Mechanical & brakes", rows });
  }

  const springs = msgs(2);
  const dampers = msgs(3);
  const alignment = msgs(4);
  let tyreCompound: number | undefined;
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
      // #3 — toe, raw slider value (verified: FL 0.1→0.06 matched the toe slider edit).
      // proto3 omits zero-valued fields, so an absent #3 means toe 0 — always render.
      const toe = num(align.fields.find((f) => f.no === 3)) ?? 0;
      rows.push(withRange({ label: "Toe", value: fmt(toe) }, toe, `${axle}Toe`));
      if (camber != null) rows.push(withRange({ label: "Camber", value: `${fmt(camber)}°` }, camber, `${axle}Camber`));
      // #7 tyre compound is car-wide, not per-corner — capture once, shown under Fuel & strategy.
      const compound = num(align.fields.find((f) => f.no === 7));
      if (compound != null) tyreCompound ??= compound;
      // #6 is a computed twin of toe (not the slider input) — hide it to avoid confusion.
      rows.push(...genericRows(align.fields, "Alignment ", new Set([1, 2, 3, 6, 7]), ALIGNMENT_GUESSES));
    }
    const spring = springs[i];
    if (spring) {
      const rate = num(spring.fields.find((f) => f.no === 1));
      if (rate != null) rows.push({ label: "Wheel rate", value: `${fmt(rate / 1000)} kN/m` });
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
  if (fuel || tyreCompound != null) {
    const rows: CarSetupRow[] = [];
    if (fuel) {
      const fuelLoad = num(fuel.fields.find((f) => f.no === 1));
      if (fuelLoad != null) rows.push(withRange({ label: "Fuel load", value: `${fmt(fuelLoad)} L` }, fuelLoad, "fuel"));
      rows.push(...genericRows(fuel.fields, "", new Set(fuelLoad != null ? [1] : [])));
    }
    // Compound index; no per-car name list exists in content.kspkg, so raw number.
    if (tyreCompound != null) rows.push({ label: "Tyre compound", value: fmt(tyreCompound) });
    sections.push({ title: "Fuel & strategy", rows });
  }

  return sections.filter((s) => s.rows.length > 0);
}

/**
 * Flatten a decoded `.carsetup` into a plain object keyed by the knob path
 * names `server/ai/tune-rules.ts` and `shared/games/ac-evo/setup-ranges.json`
 * use (`frontARB`, `brakeBias`, `frontLeftTyrePressure`, ...), so
 * `getKnobState`/`describeKnobs` return real current values instead of "?".
 *
 * Only fields whose meaning is verified (see summarizeCarSetup) are emitted.
 * ARB stiffness values (N/m) are converted to click numbers via
 * ARB_CLICK_BY_KNM and omitted when the stiffness isn't in the table —
 * never feed the model a raw N/m value as a click count.
 */
export function carSetupToKnobValues(setup: CarSetupFile): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, v: number | null | undefined) => {
    if (v != null && Number.isFinite(v)) out[key] = v;
  };
  const msgs = (no: number) =>
    setup.raw.filter((f): f is Extract<WireField, { type: "message" }> => f.no === no && f.type === "message");
  const field = (fields: WireField[] | undefined, no: number) => fields?.find((f) => f.no === no);
  const msg = (fields: WireField[] | undefined, no: number) => {
    const f = field(fields, no);
    return f?.type === "message" ? f.fields : undefined;
  };

  // #1 — mechanical/brakes/diff
  const mech = msgs(1)[0];
  if (mech) {
    const arb = mech.fields.find((f): f is Extract<WireField, { type: "bytes" }> => f.no === 1 && f.type === "bytes");
    if (arb?.floats?.length === 2) {
      const arbClick = (raw: number): number | null =>
        raw > 100 ? arbClickFromKnm(raw / 1000) : raw;
      put("frontARB", arbClick(arb.floats[0]!));
      put("rearARB", arbClick(arb.floats[1]!));
    }
    put("brakeBias", num(field(msg(mech.fields, 3), 1)));
    put("steerRatio", num(field(mech.fields, 2)));
    const diff = msg(mech.fields, 4);
    put("diffPower", num(field(diff, 1)));
    put("diffCoast", num(field(diff, 2)));
    put("diffPreload", num(field(diff, 3)));
  }

  // #2/#3/#4 — per-corner springs / dampers / alignment (FL, FR, RL, RR)
  const springs = msgs(2);
  const dampers = msgs(3);
  const alignment = msgs(4);
  const pressureKeys = ["frontLeftTyrePressure", "frontRightTyrePressure", "rearLeftTyrePressure", "rearRightTyrePressure"];
  for (let i = 0; i < 4; i++) {
    const axle = i < 2 ? "front" : "rear";
    const align = alignment[i];
    if (align) {
      put(pressureKeys[i]!, num(field(align.fields, 1)));
      // proto3 omits zero-valued fields — absent toe means 0. Per-axle keys:
      // FL/RL fill first; FR/RR would overwrite with the same axle value.
      if (out[`${axle}Toe`] === undefined) out[`${axle}Toe`] = num(field(align.fields, 3)) ?? 0;
      if (out[`${axle}Camber`] === undefined) put(`${axle}Camber`, num(field(align.fields, 2)));
    }
    if (out[`${axle}SpringRate`] === undefined) put(`${axle}SpringRate`, num(field(springs[i]?.fields, 1)));
    const damper = dampers[i];
    if (damper) {
      if (out[`${axle}Bump`] === undefined) put(`${axle}Bump`, num(field(damper.fields, 1)));
      if (out[`${axle}Rebound`] === undefined) put(`${axle}Rebound`, num(field(damper.fields, 3)));
    }
  }

  // #5 — electronics (engine map is 0-indexed in the file, 1-indexed in the UI)
  const electronics = msgs(5)[0];
  if (electronics) {
    put("tc", num(field(electronics.fields, 1)));
    put("tc2", num(field(electronics.fields, 2)));
    put("abs", num(field(electronics.fields, 3)));
    const map = num(field(electronics.fields, 4));
    if (map != null) put("engineMap", map + 1);
  }

  // #6 — aero & ride height
  const aero = msgs(6)[0];
  if (aero) {
    put("frontRideHeight", num(field(aero.fields, 2)));
    put("rearRideHeight", num(field(aero.fields, 3)));
    put("frontWing", num(field(aero.fields, 4)));
    put("rearWing", num(field(aero.fields, 5)));
  }

  // #7 — fuel load (litres)
  put("fuel", num(field(msgs(7)[0]?.fields, 1)));

  return out;
}
