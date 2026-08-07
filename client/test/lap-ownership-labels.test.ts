import { describe, expect, test } from "bun:test";
import { m } from "../src/paraglide/messages";

describe("lap ownership labels", () => {
  test("provides localized Mine and Others labels", () => {
    expect(m.import_ownership_mine()).toBe("Mine");
    expect(m.import_ownership_others()).toBe("Others");
  });
});
