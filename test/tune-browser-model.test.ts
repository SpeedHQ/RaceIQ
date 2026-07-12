import { describe, test, expect } from "bun:test";
import { buildRows } from "../client/src/components/tune/browser/buildRows";

const S = { tires:{}, gearing:{}, alignment:{}, antiRollBars:{}, springs:{}, damping:{}, aero:{}, differential:{}, brakes:{} } as any;

describe("buildRows", () => {
  test("tags sources and parses lap time", () => {
    const catalog = [
      { id: "community-1", name: "R8 — henr", author: "henr", category: "circuit", carOrdinal: 3951, description: "Got 3:48 le mans", settings: S, source: "community", sourceName: "Community" },
    ] as any[];
    const user = [
      { id: 7, name: "My R8", author: "You", category: "circuit", carOrdinal: 3951, trackOrdinal: null, description: "", settings: S },
    ];
    const rows = buildRows(catalog, user);
    const c = rows.find(r => r.id === "community-1")!;
    expect(c.source).toBe("community");
    expect(c.lapTimeSec).toBe(228);
    expect(c.lapTimeTrack).toBe("Le Mans");
    const u = rows.find(r => r.key === "user:7")!;
    expect(u.source).toBe("user");
    expect(u.dbId).toBe(7);
    expect(u.lapTimeSec).toBeNull();
  });
});
