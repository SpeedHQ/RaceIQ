import { describe, expect, test } from "bun:test";
import { validateCompareSearch } from "../src/lib/game-routes";

describe("opponent comparison URL identity", () => {
  test("retains opponent lap and source revision without coercion", () => {
    expect(validateCompareSearch({ reference: "opponent", opponentLap: "veh/2:lap-7", opponentRevision: "rev:0009", lapA: "12" })).toMatchObject({
      reference: "opponent",
      opponentLap: "veh/2:lap-7",
      opponentRevision: "rev:0009",
      lapA: 12,
    });
  });

  test("drops incomplete opponent identities and invalid reference modes", () => {
    expect(validateCompareSearch({ reference: "unexpected", opponentLap: "", opponentRevision: 42 })).toMatchObject({
      reference: undefined,
      opponentLap: undefined,
      opponentRevision: undefined,
    });
  });
});
