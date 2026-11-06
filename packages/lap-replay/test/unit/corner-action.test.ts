import { describe, expect, test } from "bun:test";
import {
  MAX_CORNER_ACTIONS,
  parseCornerActions,
  resolveCornerKey,
  resolveTurnReference,
  splitCornerActionSpans,
  type TurnIdentity,
} from "@raceiq/lap-replay/contracts";

const turn = (number: number, name?: string, aliases?: string[]): TurnIdentity => ({
  key: `turn:${number}`,
  number,
  ...(name ? { name } : {}),
  ...(aliases ? { aliases } : {}),
});

const TURNS: TurnIdentity[] = [
  turn(1, "TGR Corner", ["turn one"]),
  turn(9),
  turn(10, "Hairpin"),
  turn(11),
];

const action = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  cornerKey: "turn:1",
  label: "T1",
  target: "solo",
  span: { start: 0, end: 2 },
  ...overrides,
});

describe("corner actions", () => {
  test("accepts a valid action and drops malformed ones individually", () => {
    const parsed = parseCornerActions([action(), action({ id: "" }), action({ span: { start: 5, end: 5 } })]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cornerKey).toBe("turn:1");
  });

  test("rejects unknown targets and non-array payloads", () => {
    expect(parseCornerActions([action({ target: "C" })])).toHaveLength(0);
    expect(parseCornerActions(null)).toHaveLength(0);
    expect(parseCornerActions({})).toHaveLength(0);
  });

  test("accepts an optional text path and keeps it through validation", () => {
    const parsed = parseCornerActions([action({ path: "verdict" })]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe("verdict");
  });

  test("drops malformed actions without rejecting the whole response", () => {
    const parsed = parseCornerActions([action({ path: "verdict" }), action({ path: 42 }), action({ span: { start: -1, end: 2 } })]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe("verdict");
  });

  test("caps the number of actions", () => {
    const many = Array.from({ length: MAX_CORNER_ACTIONS + 5 }, (_, index) =>
      action({ id: `a${index}`, span: { start: 0, end: 2 } }),
    );
    expect(parseCornerActions(many)).toHaveLength(MAX_CORNER_ACTIONS);
  });

  test("T1 must not resolve to T10", () => {
    expect(resolveTurnReference("T1", TURNS)?.number).toBe(1);
    expect(resolveTurnReference("T10", TURNS)?.number).toBe(10);
    expect(resolveTurnReference("T9", TURNS)?.number).toBe(9);
  });

  test("resolves aliases and names exactly", () => {
    expect(resolveTurnReference("turn one", TURNS)?.number).toBe(1);
    expect(resolveTurnReference("Hairpin", TURNS)?.number).toBe(10);
    expect(resolveTurnReference("Turn 11", TURNS)?.number).toBe(11);
  });

  test("unknown and ambiguous references resolve to null", () => {
    expect(resolveTurnReference("T42", TURNS)).toBeNull();
    expect(resolveTurnReference("", TURNS)).toBeNull();
    const duplicate = [turn(1, "One"), { key: "turn:1", number: 1 }];
    expect(resolveTurnReference("T1", duplicate)).toBeNull();
  });

  test("canonical keys resolve exactly", () => {
    expect(resolveCornerKey("turn:10", TURNS)?.number).toBe(10);
    expect(resolveCornerKey("TURN:10", TURNS)?.number).toBe(10);
    expect(resolveCornerKey("turn:12", TURNS)).toBeNull();
  });

  test("split keeps text order and skips overlapping or out-of-range actions", () => {
    const text = "Brake later into T1 then T10";
    const start = text.indexOf("T10");
    const parts = splitCornerActionSpans(text, [
      { ...action(), span: { start, end: start + 3 } },
      { ...action({ id: "a2" }), span: { start: 17, end: 19 } },
    ]);
    expect(parts.map((part) => (part.kind === "text" ? part.text : part.action.label))).toEqual([
      "Brake later into ",
      "T1",
      " then ",
      "T1",
    ]);
  });
});
