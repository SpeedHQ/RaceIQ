/**
 * Renders a MoTeC-reconstructed lap against the centerline its channels were
 * derived from, one SVG per track, committed under
 * `test/e2e/output/motec-reconstruction/`.
 *
 * This is the check the rest of the MoTeC suite cannot make. Those tests build
 * synthetic circles and confirm the integrator runs; they cannot tell a correct
 * track from a mirrored or transposed one, because a circle looks the same
 * either way. Here the input geometry is known, so the output has something to
 * be wrong against.
 *
 * Method: differentiate a committed centerline into the speed and yaw-rate
 * channels a logger would have recorded driving it, write those into a real
 * `.ld`, run the real transcoder and the real AC Evo parser over it, then
 * compare the packets' reconstructed positions back to the centerline.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { loadCenterline } from "../../shared/racing/tracks/curation/generate";
import { parseLd } from "../../server/motec/ld";
import { synthesizeAcEvoCapture, SYNTH_HZ } from "../../server/games/ac-evo/motec";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing"
import { buildLd } from "../support/motec/ld";
import {
  alignToReference,
  centerlineToStint,
  normalizeToOriginHeading,
  signedArea,
  type Point,
} from "../support/motec/from-centerline";
import { writeOverlaySvg } from "../support/motec/overlay-svg";

initGameAdapters();
initServerGameAdapters();

const OUTPUT_DIR = resolve(import.meta.dir, "..", "e2e", "output", "motec-reconstruction");
rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Tracks to render. A spread of shapes rather than all twenty: a long fast
 * circuit, a short tight one, one with heavy elevation and one with a
 * distinctive asymmetric layout — enough that a systematic error in the
 * reconstruction has somewhere to show up, without making the suite slow.
 */
const TRACKS = ["spa", "monza", "brands-hatch", "suzuka", "laguna-seca"];

/**
 * Absolute metres, not a fraction of lap length. A percentage threshold sounds
 * safer but is useless here: 2% of Spa is 140 m, which a badly wrong map would
 * sail through. Measured across these five circuits the reconstruction lands
 * within ~1.2 m mean and ~3.7 m max, so these leave roughly 4x headroom for
 * centerline resampling noise while still failing on the errors that matter —
 * an axis transpose, a sign flip, a units mistake, an off-by-one in heading.
 *
 * Loop closure is included in what is being measured: these are the first lap
 * of a two-lap stint, so the closure ramp has already been applied.
 */
const MAX_MEAN_DEVIATION_M = 5;
const MAX_PEAK_DEVIATION_M = 20;

function* iterateFrames(buf: Buffer): Generator<Buffer> {
  let offset = 0;
  if (buf.length >= 4 && buf.readUInt32LE(0) === META_FRAME_MAGIC) offset = 12;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (len <= 0 || offset + len > buf.length) break;
    yield buf.subarray(offset, offset + len);
    offset += len;
  }
}

function reconstructPositions(bin: Buffer): Point[] {
  const game = getServerGame("ac-evo");
  const state = game.createParserState?.() ?? null;
  const points: Point[] = [];
  for (const frame of iterateFrames(bin)) {
    const packet = game.tryParse(frame, state);
    if (packet) points.push({ x: packet.PositionX, z: packet.PositionZ });
  }
  return points;
}

/** Nearest-point deviation of each reconstructed point from the reference path. */
function deviations(reference: Point[], reconstructed: Point[]): number[] {
  return reconstructed.map((r) => {
    let best = Infinity;
    for (const ref of reference) {
      const d = Math.hypot(ref.x - r.x, ref.z - r.z);
      if (d < best) best = d;
    }
    return best;
  });
}

describe("MoTeC reconstruction vs real centerlines", () => {
  for (const slug of TRACKS) {
    const raw = loadCenterline(resolve("shared/data/tracks/ac-evo", `${slug}-centerline.csv`));

    test(`${slug} reconstructs the centerline it was derived from`, () => {
      expect(raw).not.toBeNull();

      // Two laps so the first is a completed lap and goes through loop closure,
      // which is what a real import produces.
      const stint = centerlineToStint(raw!, { laps: 2, hz: SYNTH_HZ });
      const log = parseLd(buildLd(stint.spec));
      const capture = synthesizeAcEvoCapture(log, stint.beacons);
      const all = reconstructPositions(capture.bin);

      // First lap only — the second is the open final window and is not closed.
      const lapFrames = Math.min(stint.reference.length, Math.floor(all.length / 2));
      const reconstructed = all.slice(0, lapFrames);
      const reference = stint.reference.slice(0, lapFrames);
      expect(reconstructed.length).toBeGreaterThan(100);

      // Put the reconstruction back where the track actually is. Dead reckoning
      // emits every lap from the origin heading along +Z, so without this the
      // comparison silently normalises away any rotation error. Deviations are
      // unchanged by a rigid transform — what this buys is that the numbers and
      // the rendered overlay describe the same thing.
      const referenceRaw = stint.referenceRaw.slice(0, lapFrames);
      const aligned = alignToReference(reconstructed, referenceRaw);

      const devs = deviations(referenceRaw, aligned);
      const meanDeviationM = devs.reduce((a, b) => a + b, 0) / devs.length;
      const maxDeviationM = Math.max(...devs);

      // Handedness is the mirror test: a reconstruction flipped in X traces the
      // same shape with the opposite winding, which no deviation threshold
      // loose enough to allow integration drift would reliably catch.
      const refArea = signedArea(reference);
      const recArea = signedArea(normalizeToOriginHeading(reconstructed));
      const handednessMatches = Math.sign(refArea) === Math.sign(recArea);

      // Full centerline for the track outline so the panel shows the whole
      // circuit, not just the frames this lap happened to cover.
      writeOverlaySvg(OUTPUT_DIR, `${slug}-ac-evo`, "ac-evo", raw!, aligned, {
        meanDeviationM,
        maxDeviationM,
        handednessMatches,
      });

      expect(handednessMatches).toBe(true);
      expect(meanDeviationM).toBeLessThan(MAX_MEAN_DEVIATION_M);
      expect(maxDeviationM).toBeLessThan(MAX_PEAK_DEVIATION_M);

      // The lap must also actually go round the track, not sit in a corner of
      // it — a near-zero-area path would trivially satisfy a deviation bound
      // against a reference it never left the start of.
      expect(Math.abs(signedArea(reference))).toBeGreaterThan(0);
      expect(Math.abs(recArea)).toBeGreaterThan(Math.abs(refArea) * 0.8);
    });
  }

  test("a mirrored reconstruction is actually caught", () => {
    // Guards the guard: if signedArea stopped discriminating, every track above
    // would keep passing and the mirror check would be decoration.
    const raw = loadCenterline(resolve("shared/data/tracks/ac-evo", "spa-centerline.csv"));
    const stint = centerlineToStint(raw!, { laps: 2, hz: SYNTH_HZ });
    const mirrored = stint.reference.map((p) => ({ x: -p.x, z: p.z }));

    expect(Math.sign(signedArea(stint.reference))).not.toBe(Math.sign(signedArea(mirrored)));
  });
});
