/**
 * iRacing's public SDK exposes lap fraction and native sector boundaries, but
 * no stable world coordinates. Render those native boundaries over RaceIQ's
 * shared Road America reference geometry instead of inventing an iRacing
 * centerline. The committed SVG makes sector-layout changes reviewable.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
} from "fs";
import { resolve } from "path";
import {
  readIRacingFrames,
} from "../server/games/iracing/recorder";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
} from "../server/games/iracing/source-frame";
import { initGameAdapters } from "../shared/games/init";
import {
  generateTrackSegments,
  loadCenterline,
} from "../shared/track/curation/generate";
import { loadTrackFacts } from "../shared/track/storage/meta";
import { generateSegmentSvg } from "./helpers/segment-svg";

const FIXTURE =
  "test/artifacts/sessions/iracing-road-america-gt3.bin.gz";
const OUTPUT_DIR = resolve(
  import.meta.dir,
  "e2e",
  "output",
  "track-segments-native",
);
const OUTPUT = resolve(OUTPUT_DIR, "road-america-iracing.svg");

initGameAdapters();

describe("iRacing native-sector visualization", () => {
  test("renders fixture sectors on shared Road America reference geometry", () => {
    const decoder = createIRacingSourceDecoderState();
    const first = decodeIRacingSourceFrame(
      readIRacingFrames(FIXTURE, 1)[0],
      decoder,
    );
    expect(first?.session.trackName).toBe("Road America");
    expect(first?.session.sectorStarts).toEqual([0, 0.34, 0.67]);

    const facts = loadTrackFacts("road-america");
    expect(facts).not.toBeNull();
    const reference = generateTrackSegments(
      "road-america",
      facts!,
      "fm-2023",
    ).aligned[0];
    expect(reference).toBeDefined();
    const outline = loadCenterline(reference.file);
    expect(outline).not.toBeNull();

    mkdirSync(OUTPUT_DIR, { recursive: true });
    generateSegmentSvg(
      outline!,
      reference.segments,
      {
        s1End: first!.session.sectorStarts![1],
        s2End: first!.session.sectorStarts![2],
      },
      "Road America — iRacing native sectors on shared reference",
      OUTPUT,
      "iracing",
    );

    const svg = readFileSync(OUTPUT, "utf8");
    expect(svg).toContain("S1 0.340");
    expect(svg).toContain("S2 0.670");
    expect(svg).toContain("11 corners");
  });
});
