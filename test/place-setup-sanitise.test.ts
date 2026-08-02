import { describe, expect, test } from "bun:test";
import { sanitisePathSegment } from "../server/routes/tune-shared";

/**
 * `place-setup` writes `Setups/<car>/<track>/<file>` from names the client sends,
 * so this function is both a security boundary and a correctness one: it has to
 * stop traversal without quietly rewriting a legitimate folder name into one the
 * game never created.
 */
describe("sanitisePathSegment", () => {
  test("keeps hyphens — they are legal and load-bearing in real names", () => {
    // Regression: the character class used to end with an unescaped `-`, which
    // stripped every hyphen and sent the file to a folder that does not exist.
    expect(sanitisePathSegment("spa-francorchamps")).toBe("spa-francorchamps");
    expect(sanitisePathSegment("bmw_m4_gt3-2023")).toBe("bmw_m4_gt3-2023");
    expect(sanitisePathSegment("my-setup-v2.json")).toBe("my-setup-v2.json");
  });

  test("keeps ordinary names untouched", () => {
    expect(sanitisePathSegment("Brands Hatch GP")).toBe("Brands Hatch GP");
    expect(sanitisePathSegment("ferrari_296_gt3")).toBe("ferrari_296_gt3");
  });

  test("removes path separators so the write cannot escape Setups", () => {
    expect(sanitisePathSegment("../../etc")).not.toContain("/");
    expect(sanitisePathSegment("a/b")).toBe("ab");
    expect(sanitisePathSegment("a\\b")).toBe("ab");
  });

  test("removes characters Windows reserves", () => {
    expect(sanitisePathSegment('a<b>c:d"e|f?g*h')).toBe("abcdefgh");
  });

  test("removes control characters", () => {
    expect(sanitisePathSegment(`spa${String.fromCharCode(0x1f)}gp`)).toBe("spagp");
    expect(sanitisePathSegment(`a${String.fromCharCode(0x00)}b`)).toBe("ab");
  });

  test("trims surrounding whitespace", () => {
    expect(sanitisePathSegment("  monza  ")).toBe("monza");
  });
});
