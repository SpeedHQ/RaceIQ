import { isGameContextPath } from "../src/lib/sidebar-navigation";

describe("sidebar game navigation", () => {
  test("treats root home as outside game context", () => {
    expect(isGameContextPath("/", ["acc", "fm-2023"])).toBe(false);
  });

  test("treats game routes as game context", () => {
    expect(isGameContextPath("/acc/sessions", ["acc", "fm-2023"])).toBe(true);
  });
});
