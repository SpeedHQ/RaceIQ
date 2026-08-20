import { describe, expect, test } from "bun:test";
import { wheelFieldSets } from "../../../scripts/catalog/ast-discovery";

const TYPO_MESSAGE =
  'Possible wheel field typo "TyreBlistsFR": expected stem "TyreBlisters" at corner "FR".';

function capturedErrorMessage(fields: string[]): string | undefined {
  try {
    wheelFieldSets(fields);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

describe("wheel field quality", () => {
  test("rejects a near-spelled missing corner before scalar fallback regardless of ordering", () => {
    const fields = [
      "TyreBlistersFL",
      "TyreBlistsFR",
      "TyreBlistersRL",
      "TyreBlistersRR",
    ];

    expect(capturedErrorMessage(fields)).toBe(TYPO_MESSAGE);
    expect(capturedErrorMessage([...fields].reverse())).toBe(TYPO_MESSAGE);
  });

  test("accepts complete valid wheel sets, including nearby complete stems", () => {
    const fields = [
      "TyreBlistersFL",
      "TyreBlistersFR",
      "TyreBlistersRL",
      "TyreBlistersRR",
      "TyreBlistsFL",
      "TyreBlistsFR",
      "TyreBlistsRL",
      "TyreBlistsRR",
    ];

    expect(wheelFieldSets(fields).map(({ key, shape }) => ({ key, shape }))).toEqual([
      { key: "TyreBlisters", shape: "per-wheel" },
      { key: "TyreBlists", shape: "per-wheel" },
    ]);
  });

  test("accepts an unrelated same-corner field beside a three-corner stem", () => {
    const fields = [
      "TyreBlistersFL",
      "BrakePressureFR",
      "TyreBlistersRL",
      "TyreBlistersRR",
    ];

    expect(wheelFieldSets(fields).every((fieldSet) => fieldSet.shape === "scalar")).toBe(true);
  });

  test("accepts two-of-four partial stems without typo inference", () => {
    const fields = [
      "TyreBlistersFL",
      "TyreBlistersRR",
      "TyreBlistsFR",
    ];

    expect(wheelFieldSets(fields).map((fieldSet) => fieldSet.key)).toEqual(fields);
  });
});
