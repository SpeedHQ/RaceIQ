import { isGameContextPath, replaceGameRoutePrefix } from "../src/lib/sidebar-navigation";

describe("sidebar game navigation", () => {
  test("treats root home as outside game context", () => {
    expect(isGameContextPath("/", ["acc", "fm-2023"])).toBe(false);
  });

  test("treats game routes as game context", () => {
    expect(isGameContextPath("/acc/sessions", ["acc", "fm-2023"])).toBe(true);
  });

  test("replaces game root route prefix", () => {
    expect(replaceGameRoutePrefix("/acc", "acc", "fm23")).toBe("/fm23");
  });

  test("reduces nested detail routes to page root", () => {
    expect(replaceGameRoutePrefix("/acc/tracks/42/overview", "acc", "fm23")).toBe("/fm23/tracks");
    expect(replaceGameRoutePrefix("/acc/experiments/afafwfaw", "acc", "fm23")).toBe("/fm23/experiments");
  });

  test("redirects analyse to sessions when switching games", () => {
    expect(replaceGameRoutePrefix("/acc/analyse", "acc", "fm23")).toBe("/fm23/sessions");
  });

  test("uses caller-provided route prefix instead of game ID", () => {
    expect(replaceGameRoutePrefix("/acc/sessions", "acc", "f125")).toBe("/f125/sessions");
  });
});
