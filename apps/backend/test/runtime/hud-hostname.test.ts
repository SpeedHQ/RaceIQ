import {normalizeHudHostname, hudUrl} from "@raceiq/shared/platform/network/hud-hostname";
import { describe, expect, test } from "bun:test";



describe("HUD hostname override", () => {
  test("normalizes names and accepts clearing the override", () => {
    expect(normalizeHudHostname(" Race-PC.Example.ts.net ")).toBe("race-pc.example.ts.net");
    expect(normalizeHudHostname("race-pc")).toBe("race-pc");
    expect(normalizeHudHostname(" ")).toBe("");
  });
  test("rejects URLs, ports and malformed hostnames", () => {
    for (const value of ["http://pc.ts.net", "pc.ts.net:3117", "pc.ts.net/path", "pc.ts.net?x=1", "user@pc.ts.net", "-pc.ts.net", "pc-.ts.net", "pc..ts.net", "pc name", "a".repeat(64)+".net", "a.".repeat(127)+"net"]) {
      expect(normalizeHudHostname(value)).toBeNull();
    }
  });
  test("builds matching URLs without requiring a LAN address", () => {
    expect(hudUrl("race-pc.example.ts.net", 3117, "/portable/combo-1")).toBe("http://race-pc.example.ts.net:3117/portable/combo-1");
    expect(hudUrl("10.0.0.203", "3117", "/portable/combo-2")).toBe("http://10.0.0.203:3117/portable/combo-2");
    expect(hudUrl(undefined, 3117)).toBeNull();
  });
});
