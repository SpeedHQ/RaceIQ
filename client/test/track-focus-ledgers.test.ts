import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const viewPath = new URL("../src/components/tunes/track-focus/TrackFocusView.tsx", import.meta.url);
const ledgerPath = new URL("../src/components/tunes/track-focus/SegmentLedger.tsx", import.meta.url);

describe("track focus ledger layout", () => {
  test("renders sector ledger above segment ledger without a granularity toggle", async () => {
    const source = await readFile(viewPath, "utf8");

    expect(source.indexOf("<SectorLedger")).toBeLessThan(source.indexOf("<SegmentLedger"));
    expect(source).not.toContain("Consistency ledger granularity");
    expect(source).not.toContain("ledgerMode");
  });

  test("labels former corner ledger as segment ledger", async () => {
    const source = await readFile(ledgerPath, "utf8");

    expect(source).toContain(">Segment Ledger</div>");
    expect(source).toContain('["Segment", "Speed range"');
    expect(source).toContain("No segment data available");
  });
});
