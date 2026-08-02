/**
 * AC EVO `.carsetup` byte-patch encoder.
 *
 * `carsetup-wire.ts` decodes the schema-free wire tree and records byte spans;
 * `carsetup.ts` assigns heuristic semantic labels. A full re-encode from a
 * structured object is too risky because a wrong field guess would corrupt a
 * save the game must load. Instead this module patches only edited field bytes
 * and copies every other byte verbatim from the source.
 *
 * Only knobs exposed by `server/setups/rules/catalog.ts`'s "ac-evo" table
 * are writable here — the same set `describeKnobs`/`getAllKnobStates`
 * expose to the Setup Engineer. Anything else throws (never a silent skip).
 *
 * See docs/contributing/setup-range-data.md.
 */
import { ARB_CLICK_BY_KNM, carSetupToKnobValues } from "./carsetup";
import { parseCarSetup, type WireField } from "./carsetup-wire";

export interface CarSetupEdit {
  knob: string;
  value: number;
}

type KnobKind = "float" | "fixed64" | "varint" | "packedFloatBytes";

interface KnobFieldSpec {
  /** Field numbers from the top-level message down to the target field. */
  path: number[];
  kind: KnobKind;
  /** Index into the packed-floats array (packedFloatBytes only). */
  floatIndex?: number;
  /** Knob units (e.g. ARB click) -> raw file units (e.g. N/m). */
  toRaw: (knobValue: number) => number;
}

const identity = (v: number): number => v;

/** click -> kN/m, the reverse of `arbClickFromKnm`. Unknown clicks throw at
 *  edit time (below) rather than silently writing a bogus stiffness. */
function knmFromArbClick(click: number): number {
  const kNm = Object.entries(ARB_CLICK_BY_KNM).find(([, c]) => c === click)?.[0];
  if (kNm == null) {
    throw new Error(`patchCarSetup: no known ARB stiffness mapping for click ${click}`);
  }
  return Number(kNm) * 1000;
}

/**
 * Knob -> field resolution, mirroring `carSetupToKnobValues`'s reverse
 * direction. Deliberately covers only knobs setup rule catalog's "ac-evo"
 * table exposes (Front/Rear ARB, Brake Bias, Front/Rear Wing) — every other
 * decoded value (ride height, dampers, tyre pressures, TC/ABS, ...) has no
 * verified in-game slider mapping for writing yet and stays read-only.
 */
const KNOB_FIELDS: Record<string, KnobFieldSpec> = {
  frontARB: { path: [1, 1], kind: "packedFloatBytes", floatIndex: 0, toRaw: knmFromArbClick },
  rearARB: { path: [1, 1], kind: "packedFloatBytes", floatIndex: 1, toRaw: knmFromArbClick },
  brakeBias: { path: [1, 3, 1], kind: "float", toRaw: identity },
  frontWing: { path: [6, 4], kind: "float", toRaw: identity },
  rearWing: { path: [6, 5], kind: "float", toRaw: identity },
};

/** The knob names `patchCarSetup` can write. */
export const WRITABLE_CARSETUP_KNOBS: readonly string[] = Object.keys(KNOB_FIELDS);

function resolvePath(fields: WireField[], path: number[]): WireField | null {
  let current = fields;
  for (let i = 0; i < path.length; i++) {
    const f = current.find((x) => x.no === path[i]);
    if (!f) return null;
    if (i === path.length - 1) return f;
    if (f.type !== "message") return null;
    current = f.fields;
  }
  return null;
}

function encodeVarint(value: bigint): Buffer {
  if (value < 0n) throw new Error("patchCarSetup: negative varints are not supported");
  const bytes: number[] = [];
  let v = value;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeTag(no: number, wire: number): Buffer {
  return encodeVarint(BigInt((no << 3) | wire));
}

/**
 * Re-serialize `fields` (a message's decoded field list), rewriting only
 * fields present in `edited` (leaf value -> new raw bytes for that field's
 * value/payload) and copying every other field's bytes verbatim from
 * `source` via its recorded span. Message fields containing an edited
 * descendant are recursively rebuilt (which naturally re-encodes their
 * length prefix); message fields with no edited descendant are copied
 * verbatim, tag/length-prefix and all.
 *
 * Exported for the varint-ripple unit test (no real AC-EVO knob is
 * varint-backed in observed fixtures, so `patchCarSetup` itself never
 * exercises the resize path — this function does, generically).
 */
export function rebuildFields(source: Buffer, fields: WireField[], edited: Map<WireField, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const f of fields) {
    const newBytes = edited.get(f);
    if (newBytes) {
      if (f.type === "varint") {
        parts.push(encodeTag(f.no, 0), newBytes);
      } else if (f.type === "float") {
        parts.push(encodeTag(f.no, 5), newBytes);
      } else if (f.type === "fixed64") {
        parts.push(encodeTag(f.no, 1), newBytes);
      } else if (f.type === "bytes") {
        parts.push(encodeTag(f.no, 2), encodeVarint(BigInt(newBytes.length)), newBytes);
      } else {
        throw new Error(`patchCarSetup: unsupported edited field type "${f.type}"`);
      }
      continue;
    }
    if (f.type === "message" && containsEdit(f, edited)) {
      const childBuf = rebuildFields(source, f.fields, edited);
      parts.push(encodeTag(f.no, 2), encodeVarint(BigInt(childBuf.length)), childBuf);
      continue;
    }
    // Untouched — copy verbatim (tag through value/payload end) from source.
    if (f.tagStart == null || f.valueEnd == null) {
      throw new Error("patchCarSetup: decoded field is missing byte spans (stale parse?)");
    }
    parts.push(source.subarray(f.tagStart, f.valueEnd));
  }
  return Buffer.concat(parts);
}

function containsEdit(field: WireField, edited: Map<WireField, Buffer>): boolean {
  if (edited.has(field)) return true;
  if (field.type !== "message") return false;
  return field.fields.some((child) => containsEdit(child, edited));
}

/**
 * Byte-patch a `.carsetup` buffer, applying `edits` (knob name + new value,
 * same units `carSetupToKnobValues` reports) and returning a new buffer.
 * Every byte outside the edited fields (and the length prefixes of their
 * ancestor messages, if a resize ever occurs) is identical to `buf`.
 *
 * Unknown/unwritable knobs throw immediately. After patching, the output is
 * re-decoded and verified: every edited knob must read back as the value
 * requested, and every other knob `carSetupToKnobValues` exposes must be
 * unchanged from the original decode. Any mismatch throws and discards the
 * patched buffer — a wrong field-number guess degrades to a thrown error,
 * never a corrupted save.
 */
export function patchCarSetup(buf: Buffer, edits: CarSetupEdit[]): Buffer {
  if (edits.length === 0) return Buffer.from(buf);

  const original = parseCarSetup(buf);
  if (!original) throw new Error("patchCarSetup: source buffer is not a valid .carsetup wire file");
  const originalKnobs = carSetupToKnobValues(original);

  const targetByKnob = new Map<string, number>();
  const floatEdits = new Map<WireField, number>();
  const packedEdits = new Map<WireField, Map<number, number>>();

  for (const { knob, value } of edits) {
    const spec = KNOB_FIELDS[knob];
    if (!spec) {
      throw new Error(`patchCarSetup: knob "${knob}" is not writable (not in the AC-EVO tune-rules table)`);
    }
    const field = resolvePath(original.raw, spec.path);
    if (!field) {
      throw new Error(`patchCarSetup: could not locate the field for knob "${knob}" in this file`);
    }
    const raw = spec.toRaw(value);
    if (spec.kind === "packedFloatBytes") {
      if (field.type !== "bytes" || !field.floats) {
        throw new Error(`patchCarSetup: knob "${knob}" — expected a packed-floats field, found ${field.type}`);
      }
      let byIndex = packedEdits.get(field);
      if (!byIndex) {
        byIndex = new Map();
        packedEdits.set(field, byIndex);
      }
      byIndex.set(spec.floatIndex!, raw);
    } else if (spec.kind === "float") {
      if (field.type !== "float") {
        throw new Error(`patchCarSetup: knob "${knob}" — expected a float field, found ${field.type}`);
      }
      floatEdits.set(field, raw);
    } else if (spec.kind === "fixed64") {
      if (field.type !== "fixed64") {
        throw new Error(`patchCarSetup: knob "${knob}" — expected a fixed64 field, found ${field.type}`);
      }
      floatEdits.set(field, raw);
    } else {
      if (field.type !== "varint") {
        throw new Error(`patchCarSetup: knob "${knob}" — expected a varint field, found ${field.type}`);
      }
      floatEdits.set(field, raw);
    }
    targetByKnob.set(knob, value);
  }

  const encoded = new Map<WireField, Buffer>();
  for (const [field, raw] of floatEdits) {
    if (field.type === "float") {
      const b = Buffer.alloc(4);
      b.writeFloatLE(raw, 0);
      encoded.set(field, b);
    } else if (field.type === "fixed64") {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(raw, 0);
      encoded.set(field, b);
    } else if (field.type === "varint") {
      encoded.set(field, encodeVarint(BigInt(Math.round(raw))));
    }
  }
  for (const [field, byIndex] of packedEdits) {
    if (field.type !== "bytes" || !field.floats) continue;
    const floats = field.floats.slice();
    for (const [idx, v] of byIndex) floats[idx] = v;
    const b = Buffer.alloc(floats.length * 4);
    floats.forEach((v, i) => b.writeFloatLE(v, i * 4));
    encoded.set(field, b);
  }

  const patched = rebuildFields(buf, original.raw, encoded);

  // Mandatory read-back verification (design §4).
  const reparsed = parseCarSetup(patched);
  if (!reparsed) {
    throw new Error("patchCarSetup: verification failed — patched output did not re-parse as valid wire data");
  }
  const newKnobs = carSetupToKnobValues(reparsed);
  for (const [knob, expected] of targetByKnob) {
    const got = newKnobs[knob];
    if (got == null || Math.abs(got - expected) > 1e-3) {
      throw new Error(
        `patchCarSetup: verification failed — knob "${knob}" expected ${expected}, read back ${got ?? "undefined"}`,
      );
    }
  }
  for (const key of Object.keys(originalKnobs)) {
    if (targetByKnob.has(key)) continue;
    const before = originalKnobs[key]!;
    const after = newKnobs[key];
    if (after == null || Math.abs(before - after) > 1e-6) {
      throw new Error(`patchCarSetup: verification failed — untouched knob "${key}" changed (${before} -> ${after})`);
    }
  }

  return patched;
}
