import { describe, expect, test } from "bun:test";
import { normalizeSuspensionTravel } from "../../client/src/lib/suspension";

describe("normalizeSuspensionTravel", () => {
  test("returns neutral values when telemetry is absent", () => {
    expect(normalizeSuspensionTravel(undefined)).toEqual([0, 0, 0, 0]);
  });
});
