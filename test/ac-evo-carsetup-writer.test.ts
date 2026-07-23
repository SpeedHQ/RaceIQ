import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseCarSetup, carSetupToKnobValues } from "../server/games/ac-evo/carsetup";
import { patchCarSetup, rebuildFields, WRITABLE_CARSETUP_KNOBS, type CarSetupEdit } from "../server/games/ac-evo/carsetup-writer";
import type { WireField } from "../server/games/ac-evo/carsetup";

const FIXTURE = join(import.meta.dir, "artifacts", "carsetup", "Default-12312.carsetup");
const fixtureBuf = () => readFileSync(FIXTURE);

// Default-12312's front wing (aero field #4) is proto3-omitted (value 0 in
// game), so it isn't present as bytes in that file — patching a field that
// doesn't exist yet is out of scope (design covers overwrite, not insert).
// "F1 default.carsetup" has both wing fields present; use it for wing edits.
const WING_FIXTURE = join(import.meta.dir, "artifacts", "carsetup", "F1 default.carsetup");
const wingFixtureBuf = () => readFileSync(WING_FIXTURE);

describe("patchCarSetup — round trip on real fixtures", () => {
  it("patches brakeBias and reads back the new value, unchanged elsewhere", () => {
    const buf = fixtureBuf();
    const before = carSetupToKnobValues(parseCarSetup(buf)!);
    expect(before.brakeBias).toBeCloseTo(52.6, 1);

    const patched = patchCarSetup(buf, [{ knob: "brakeBias", value: 55 }]);
    const after = carSetupToKnobValues(parseCarSetup(patched)!);
    expect(after.brakeBias).toBeCloseTo(55, 3);

    // Everything else unchanged.
    for (const key of Object.keys(before)) {
      if (key === "brakeBias") continue;
      expect(after[key]).toBeCloseTo(before[key]!, 3);
    }
  });

  it("patches frontARB (packed-float click->kN/m reverse mapping)", () => {
    const buf = fixtureBuf();
    const patched = patchCarSetup(buf, [{ knob: "frontARB", value: 1 }]);
    const after = carSetupToKnobValues(parseCarSetup(patched)!);
    expect(after.frontARB).toBe(1);
    // rearARB (same packed bytes field, other float slot) must be untouched.
    const before = carSetupToKnobValues(parseCarSetup(buf)!);
    expect(after.rearARB).toBe(before.rearARB);
  });

  it("patches rearARB independently of frontARB", () => {
    const buf = fixtureBuf();
    const patched = patchCarSetup(buf, [{ knob: "rearARB", value: 2 }]);
    const after = carSetupToKnobValues(parseCarSetup(patched)!);
    expect(after.rearARB).toBe(2);
  });

  it("patches both frontARB and rearARB together in one call (shared packed field)", () => {
    const buf = fixtureBuf();
    const patched = patchCarSetup(buf, [
      { knob: "frontARB", value: 2 },
      { knob: "rearARB", value: 1 },
    ]);
    const after = carSetupToKnobValues(parseCarSetup(patched)!);
    expect(after.frontARB).toBe(2);
    expect(after.rearARB).toBe(1);
  });

  it("patches frontWing and rearWing (aero floats)", () => {
    const buf = wingFixtureBuf();
    const before = carSetupToKnobValues(parseCarSetup(buf)!);
    const patched = patchCarSetup(buf, [
      { knob: "frontWing", value: 5 },
      { knob: "rearWing", value: 3 },
    ]);
    const after = carSetupToKnobValues(parseCarSetup(patched)!);
    expect(after.frontWing).toBe(5);
    expect(after.rearWing).toBe(3);
    expect(after.rearRideHeight).toBeCloseTo(before.rearRideHeight!, 3);
  });

  it("byte-diff: only the edited field's bytes change, buffer length unchanged (float overwrite)", () => {
    const buf = fixtureBuf();
    const patched = patchCarSetup(buf, [{ knob: "brakeBias", value: 60 }]);
    expect(patched.length).toBe(buf.length);
    let diffCount = 0;
    let firstDiff = -1;
    let lastDiff = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== patched[i]) {
        diffCount++;
        if (firstDiff === -1) firstDiff = i;
        lastDiff = i;
      }
    }
    // A float overwrite touches at most 4 bytes (the value), never the tag.
    expect(diffCount).toBeGreaterThan(0);
    expect(diffCount).toBeLessThanOrEqual(4);
    expect(lastDiff - firstDiff).toBeLessThan(4);
  });
});

describe("patchCarSetup — every tunable knob at min and max", () => {
  it("patches each writable knob to its tune-rules min and max without corrupting other knobs", async () => {
    const { getAllKnobStates } = await import("../server/ai/tune-rules");
    const buf = wingFixtureBuf();
    const originalKnobs = carSetupToKnobValues(parseCarSetup(buf)!);
    const states = getAllKnobStates("ac-evo", originalKnobs);
    const byComponent = new Map(states.map((s) => [s.component, s]));

    const componentToKnob: Record<string, string> = {
      "Front Anti-Roll Bar": "frontARB",
      "Rear Anti-Roll Bar": "rearARB",
      "Brake Bias": "brakeBias",
      "Front Wing": "frontWing",
      "Rear Wing": "rearWing",
    };

    for (const [component, knob] of Object.entries(componentToKnob)) {
      expect(WRITABLE_CARSETUP_KNOBS).toContain(knob);
      const state = byComponent.get(component);
      expect(state).toBeDefined();
      for (const edgeValue of [state!.min, state!.max]) {
        // ARB clicks only have a known reverse mapping for 1/2/3 (audi table)
        // — clamp the probe to that table's domain for this knob/fixture.
        const probe = knob === "frontARB" || knob === "rearARB" ? Math.min(3, Math.max(1, Math.round(edgeValue))) : edgeValue;
        const patched = patchCarSetup(buf, [{ knob, value: probe }]);
        const after = carSetupToKnobValues(parseCarSetup(patched)!);
        expect(after[knob]).toBeCloseTo(probe, 2);
      }
    }
  });
});

describe("patchCarSetup — error handling", () => {
  it("throws on an unknown knob rather than silently skipping it", () => {
    const buf = fixtureBuf();
    expect(() => patchCarSetup(buf, [{ knob: "notARealKnob", value: 1 }])).toThrow(/not writable/i);
  });

  it("throws on an ARB click with no known stiffness mapping instead of guess-writing", () => {
    const buf = fixtureBuf();
    expect(() => patchCarSetup(buf, [{ knob: "frontARB", value: 99 }])).toThrow(/no known ARB stiffness mapping/i);
  });

  it("returns the buffer unchanged (new instance) when edits is empty", () => {
    const buf = fixtureBuf();
    const patched = patchCarSetup(buf, []);
    expect(Buffer.compare(buf, patched)).toBe(0);
    expect(patched).not.toBe(buf);
  });
});

describe("rebuildFields — varint resize ripple (synthetic buffer, 127-boundary crossing)", () => {
  /**
   * No real AC-EVO knob is varint-backed in the fixtures on hand (every
   * writable knob resolves to a float), so this exercises the generic
   * resize/ripple path directly against a hand-built wire buffer:
   *   outer message: field #1 = nested message { field #1 = varint 100 }
   * Editing the inner varint from 100 (1 byte) to 200 (2 bytes) must grow
   * the inner message's payload by 1 byte, which must ripple into the outer
   * message's length prefix for field #1.
   */
  function encodeVarintRaw(n: number): Buffer {
    const bytes: number[] = [];
    let v = n;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v > 0) b |= 0x80;
      bytes.push(b);
    } while (v > 0);
    return Buffer.from(bytes);
  }
  function buildSyntheticBuffer(innerVarint: number): Buffer {
    // inner message: tag(#1, varint=wire0) + varint value
    const innerTag = Buffer.from([(1 << 3) | 0]);
    const innerValue = encodeVarintRaw(innerVarint);
    const innerMsg = Buffer.concat([innerTag, innerValue]);
    // outer: tag(#1, wire2) + len(innerMsg) + innerMsg
    const outerTag = Buffer.from([(1 << 3) | 2]);
    const outerLen = encodeVarintRaw(innerMsg.length);
    return Buffer.concat([outerTag, outerLen, innerMsg]);
  }

  it("re-encodes the ancestor length prefix when the varint's byte size grows", () => {
    const buf = buildSyntheticBuffer(100); // 100 encodes as 1 byte (0x64)
    const tree = parseCarSetup(buf)!;
    const outer = tree.raw.find((f) => f.no === 1 && f.type === "message") as Extract<WireField, { type: "message" }>;
    expect(outer).toBeDefined();
    const inner = outer.fields.find((f) => f.no === 1 && f.type === "varint")!;
    expect(inner.type).toBe("varint");
    expect((inner as any).value).toBe("100");

    // 200 requires 2 bytes as a varint (crosses the 7-bit/127 boundary).
    const newVarintBytes = encodeVarintRaw(200);
    expect(newVarintBytes.length).toBe(2);
    const edited = new Map<WireField, Buffer>([[inner, newVarintBytes]]);
    const patched = rebuildFields(buf, tree.raw, edited);

    expect(patched.length).toBe(buf.length + 1); // inner grew by 1 byte

    const reparsed = parseCarSetup(patched)!;
    const outer2 = reparsed.raw.find((f) => f.no === 1 && f.type === "message") as Extract<WireField, { type: "message" }>;
    const inner2 = outer2.fields.find((f) => f.no === 1 && f.type === "varint")!;
    expect((inner2 as any).value).toBe("200");
  });

  it("leaves the buffer byte-identical when no field is edited", () => {
    const buf = buildSyntheticBuffer(50);
    const tree = parseCarSetup(buf)!;
    const patched = rebuildFields(buf, tree.raw, new Map());
    expect(Buffer.compare(buf, patched)).toBe(0);
  });
});
