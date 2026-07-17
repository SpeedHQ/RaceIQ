import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { TrackGuideFileSchema } from "../server/ai/track-guides";

/**
 * Build gate for guide-file shape. Guides are static repo assets loaded with a
 * blind cast in production (no per-start validation on the hot path), so a
 * malformed file must fail HERE in CI rather than silently rendering blank
 * prose or crashing mid-request in prod.
 */
const guidesDir = resolve(import.meta.dir, "../shared/tracks/guides");
const files = readdirSync(guidesDir).filter((f) => f.endsWith(".json"));

describe("track guide files conform to schema", () => {
  test("at least one guide file exists", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(file, () => {
      const raw = JSON.parse(readFileSync(resolve(guidesDir, file), "utf8"));
      const r = TrackGuideFileSchema.safeParse(raw);
      if (!r.success) {
        const issues = r.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ");
        throw new Error(`Invalid track guide ${file}: ${issues}`);
      }
      // Filename (minus .json) must match the guide's own id.
      expect(r.data.id).toBe(file.replace(/\.json$/, ""));
    });
  }
});
