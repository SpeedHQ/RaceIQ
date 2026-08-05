/**
 * AC Evo v0.6 shared memory recording smoke test.
 *
 * Globs the latest ac-evo-*.bin in test/artifacts/sessions and validates the v0.6
 * parser against it. Skipped if no recording exists.
 *
 * v0.6 confirmed working (via `Local\acevo_pmf_*` mappings, not ACC's acpmf_*):
 *   - Physics live at ~300 Hz (speed, rpm, gear, tire temps, pressures)
 *   - Graphics live at ~60 Hz (status, lap times, npos, car_model)
 *   - Static may be empty in solo/time-attack sessions — session=-1 (AC_UNKNOWN)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { CapturedLap } from "../../../server/telemetry/pipeline-ports"
import {
	readAcEvoPackets,
	parseDump,
	ensureInit,
} from "../../support/recordings/parse-dump";
import { generateRecordingVisualizations } from "../../support/laps/visualizations";
import { assertValidLapHasSectors } from "../../support/laps/assertions";
import { getTrackSectorsByOrdinal } from "../../../shared/racing/tracks/storage/sectors";

type CapturedLapWithPackets = CapturedLap & { packets: TelemetryPacket[] };

const AC_EVO_RECORDING =
	"test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";
const recording = existsSync(AC_EVO_RECORDING) ? AC_EVO_RECORDING : null;

let packets: TelemetryPacket[] = [];
let carModel: string | null = null;
let trackName: string | null = null;
let laps: CapturedLapWithPackets[] = [];

beforeAll(async () => {
	if (!recording) return;
	ensureInit();
	const result = readAcEvoPackets(recording);
	packets = result.packets;
	carModel = result.carModel;
	trackName = result.trackName;
	// Also run through the full pipeline so we get lap detection + outlap/inlap classification
	const dump = await parseDump("ac-evo", recording);
	if (dump.laps.some((lap) => lap.packets === undefined)) {
		throw new Error("parseDump returned a lap without test packets");
	}
	laps = dump.laps as CapturedLapWithPackets[];
});

describe("AC Evo v0.6 recording", () => {
	test("parses packets with correct gameId", () => {
		if (!recording) return;
		expect(packets.length).toBeGreaterThan(100);
		expect(packets[0].gameId).toBe("ac-evo");
	});

	test("car model resolved from graphics page", () => {
		if (!recording) return;
		// v0.6 puts car_model in GRAPHICS_EVO (char[33] at offset 3086), not STATIC
		expect(carModel).toBeTruthy();
		expect(carModel!.length).toBeGreaterThan(3);
	});

	test("static page may be empty in solo sessions — that's expected", () => {
		if (!recording) return;
		// Time attack / free practice leaves STATIC_EVO largely unpopulated.
		// Track name comes from the pipeline's track ordinal lookup, not static.
		// Just assert we don't throw — null is acceptable.
		expect(trackName === null || typeof trackName === "string").toBe(true);
	});

	test("physics: speed, rpm, gear all live and plausible", () => {
		if (!recording) return;
		const maxSpeed = Math.max(...packets.map((p) => p.Speed));
		const maxRpm = Math.max(...packets.map((p) => p.CurrentEngineRpm));
		const gears = new Set(packets.map((p) => p.Gear));
		// Speed in m/s — GT3 easily exceeds 40 m/s (144 km/h)
		expect(maxSpeed).toBeGreaterThan(30);
		expect(maxRpm).toBeGreaterThan(4000);
		expect(maxRpm).toBeLessThan(12000);
		expect(gears.size).toBeGreaterThan(2);
	});

	test("tire pressures and temps populated", () => {
		if (!recording) return;
		const movingPacket = packets.find((p) => p.Speed > 13);
		expect(movingPacket).toBeDefined();
		expect(movingPacket!.TirePressureFrontLeft).toBeGreaterThan(15);
		expect(movingPacket!.TirePressureFrontLeft).toBeLessThan(50);
		expect(movingPacket!.TireTempFL).toBeGreaterThan(20);
		expect(movingPacket!.TireCarcassTempFL).toBeGreaterThan(20);
		expect(movingPacket!.TireSurfaceTempInnerFL).toBeUndefined();
		expect(movingPacket!.TireSurfaceTempMiddleFL).toBeUndefined();
		expect(movingPacket!.TireSurfaceTempOuterFL).toBeUndefined();
	});

	test("lap timing: current_lap_time_ms ticks up during a lap", () => {
		if (!recording) return;
		// CurrentLap is derived from current_lap_time_ms (offset 188) / 1000
		const lapTimes = packets.map((p) => p.CurrentLap).filter((t) => t > 0);
		expect(lapTimes.length).toBeGreaterThan(100);
		// Max current lap time should be at least 30s (a real lap)
		expect(Math.max(...lapTimes)).toBeGreaterThan(30);
	});

	test("npos (normalized track position) ramps 0→1", () => {
		if (!recording) return;
		const nposValues = packets
			.map(
				(p) =>
					(p.acc as { normalizedCarPosition?: number })?.normalizedCarPosition,
			)
			.filter((v): v is number => typeof v === "number" && v > 0);
		expect(nposValues.length).toBeGreaterThan(100);
		const maxNpos = Math.max(...nposValues);
		expect(maxNpos).toBeGreaterThan(0.5); // driver got at least halfway round a lap
		expect(maxNpos).toBeLessThanOrEqual(1.0);
	});

	test("status is AC_LIVE (2) during recorded session", () => {
		if (!recording) return;
		// IsRaceOn=1 is derived from status===2 in parser
		const liveCount = packets.filter((p) => p.IsRaceOn === 1).length;
		// Majority of recorded frames should be live
		expect(liveCount / packets.length).toBeGreaterThan(0.5);
	});

	// This recording holds three laps and no clean one: a garage-start outlap, a
	// flying lap the driver threw away (speed collapses 46 → 8 km/h at 25.6s and
	// AC Evo clears `is_valid_lap` for the remaining 4825 frames), then a lap cut
	// short when the recorder stopped. So the assertion is the full classification
	// of those three, including the provenance of the track-limits cut — an
	// `is_valid_lap` flag misread would flunk the "clean at the line" half.
	test("lap detection: outlap, a thrown-away flying lap, incomplete final lap", () => {
		if (!recording) return;
		// Log what we got for debugging
		for (const l of laps) {
			const s = l.sectors;
			const sectorStr = s
				? ` ${s.map((time, index) => `s${index + 1}=${time.toFixed(3)}`).join(" ")} Σ=${s.reduce((sum, time) => sum + time, 0).toFixed(3)}`
				: " sectors=null";
			console.log(
				`  lap ${l.lapNumber}: ${l.lapTime.toFixed(3)}s ${l.isValid ? "valid" : "invalid"}${l.invalidReason ? ` (${l.invalidReason})` : ""}${sectorStr}`,
			);
		}

		expect(laps.length).toBe(3);

		// Lap 1: outlap — driver exits pit, not a valid timed lap
		expect(laps[0].invalidReason).toBe("outlap");
		expect(laps[0].isValid).toBe(false);

		// Lap 2: a real flying lap, invalidated on track rather than by pit contact.
		const flying = laps[1];
		expect(flying.invalidReason).toBe("track limits");
		expect(flying.isValid).toBe(false);
		// Provenance of the cut: the lap started clean, went invalid mid-lap, and
		// stayed invalid — not a flag inherited across the start/finish line.
		const flyingPackets = flying.packets ?? [];
		expect(flyingPackets[0].acc?.isValidLap).toBe(true);
		const cutIdx = flyingPackets.findIndex((p) => p.acc?.isValidLap === false);
		expect(cutIdx).toBeGreaterThan(0);
		expect(flyingPackets.slice(cutIdx).every((p) => p.acc?.isValidLap === false)).toBe(true);
		// The car really did leave the track: speed collapses across the cut.
		expect(flyingPackets[cutIdx].Speed).toBeLessThan(flyingPackets[cutIdx - 600].Speed / 2);

		// Both complete laps must still be timed and sectored like real laps.
		for (const l of [laps[0], flying]) {
			// GT3 lap at any real circuit: 60-180s
			expect(l.lapTime).toBeGreaterThan(60);
			expect(l.lapTime).toBeLessThan(180);
			assertValidLapHasSectors(l);
		}

		// Final lap: recording stopped mid-lap
		const last = laps[laps.length - 1];
		expect(last.isValid).toBe(false);
		expect(last.invalidReason).toBe("incomplete");
	});

	test("stored lap time matches game's last_laptime_ms at lap transition", () => {
		if (!recording) return;
		// For each completed lap, the *next* lap's first packet carries the game's
		// authoritative last_laptime_ms (already in packet.LastLap, seconds).
		// Our pipeline should store that same value — not the overshoot from
		// peak CurrentLap on the previous lap.
		for (let k = 0; k < laps.length - 1; k++) {
			const lap = laps[k];
			const nextLap = laps[k + 1];
			if (nextLap.packets.length === 0) continue;

			const firstPkt = nextLap.packets[0];
			const gameLastLapMs = Math.round(firstPkt.LastLap * 1000);
			const storedMs = Math.round(lap.lapTime * 1000);

			// Max CurrentLap on the previous lap shows sampling overshoot
			const maxCurrentLapMs = Math.round(
				Math.max(...lap.packets.map((p) => p.CurrentLap)) * 1000,
			);

			console.log(
				`  lap ${lap.lapNumber}: stored=${storedMs}ms gameLastT=${gameLastLapMs}ms ` +
					`peakCurT=${maxCurrentLapMs}ms (overshoot=${maxCurrentLapMs - gameLastLapMs}ms)`,
			);

			// Skip bogus game values (0 or INT32 sentinel)
			if (gameLastLapMs <= 0 || gameLastLapMs > 1000 * 60 * 10) continue;

			// Stored lap time must match game's authoritative value exactly (ms precision)
			expect(storedMs).toBe(gameLastLapMs);
		}
	});

	// Sector splitting is driven by distance fractions and packet timestamps, so
	// it is orthogonal to lap validity — assert it on every lap the driver
	// actually completed. (This recording has no clean lap; see above.)
	test("sector times align with track's s1/s2 fractions and sum exactly", () => {
		if (!recording) return;
		const completeLaps = laps.filter((l) => l.sectors && l.invalidReason !== "incomplete");
		expect(completeLaps.length).toBeGreaterThanOrEqual(1);

		for (const l of completeLaps) {
			const s = l.sectors!;

			// Strict sum: stored lap time and sector sum both derive from the same
			// packet timestamps, so they must match at ms precision.
			const sumMs = Math.round(s.reduce((sum, time) => sum + time, 0) * 1000);
			const lapMs = Math.round(l.lapTime * 1000);
			expect(sumMs).toBe(lapMs);

			// Compare measured time-fractions against the track's distance-fractions.
			// Time and distance diverge due to speed profile (slow corners inflate
			// time in one sector), so allow a wide ±0.12 absolute tolerance. This
			// still catches a collapsed/miscomputed boundary (e.g. s1 taking 80% of
			// lap time when the split is at 31% of distance).
			const trackOrdinal = l.packets[0].TrackOrdinal ?? 0;
			const meta = getTrackSectorsByOrdinal(trackOrdinal);
			const s1Frac = s[0] / l.lapTime;
			const s12Frac = (s[0] + s[1]) / l.lapTime;
			expect(Math.abs(s1Frac - meta.s1End)).toBeLessThan(0.12);
			expect(Math.abs(s12Frac - meta.s2End)).toBeLessThan(0.12);
		}

		// Consistency across laps: same sector should not vary by more than
		// 10s (catches a bad boundary/reset on one lap).
		if (completeLaps.length >= 2) {
			const sectorCount = completeLaps[0].sectors!.length;
			for (let sectorIndex = 0; sectorIndex < sectorCount; sectorIndex++) {
				const values = completeLaps.map((l) => l.sectors![sectorIndex]);
				const spread = Math.max(...values) - Math.min(...values);
				expect(spread).toBeLessThan(10);
			}
		}
	});

	test("outputs SVG visualization", () => {
		if (!recording) return;
		const sampled = packets.filter((_, i) => i % 10 === 0);
		generateRecordingVisualizations(
			recording.split(/[\\/]/).pop()!,
			laps,
			sampled,
		);
	});
});
