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
import { existsSync } from "fs";
import type { TelemetryPacket } from "../../../shared/types";
import type { CapturedLap } from "../../../server/pipeline-adapters";
import {
	readAcEvoPackets,
	parseDump,
	ensureInit,
} from "../../helpers/parse-dump";
import { generateRecordingVisualizations } from "../../helpers/lap-viz";
import { assertValidLapHasSectors } from "../../helpers/lap-assertions";
import { getTrackSectorsByOrdinal } from "../../../shared/track-data";

const AC_EVO_RECORDING =
	"test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";
const recording = existsSync(AC_EVO_RECORDING) ? AC_EVO_RECORDING : null;

let packets: TelemetryPacket[] = [];
let carModel: string | null = null;
let trackName: string | null = null;
let laps: CapturedLap[] = [];

beforeAll(async () => {
	if (!recording) return;
	ensureInit();
	const result = readAcEvoPackets(recording);
	packets = result.packets;
	carModel = result.carModel;
	trackName = result.trackName;
	// Also run through the full pipeline so we get lap detection + outlap/inlap classification
	const dump = await parseDump("ac-evo", recording);
	laps = dump.laps;
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

	test("lap detection: outlap invalid, at least one valid flying lap, final lap invalid", () => {
		if (!recording) return;
		// Log what we got for debugging
		for (const l of laps) {
			const s = l.sectors;
			const sectorStr = s
				? ` s1=${s.s1.toFixed(3)} s2=${s.s2.toFixed(3)} s3=${s.s3.toFixed(3)} Σ=${(s.s1 + s.s2 + s.s3).toFixed(3)}`
				: " sectors=null";
			console.log(
				`  lap ${l.lapNumber}: ${l.lapTime.toFixed(3)}s ${l.isValid ? "valid" : "invalid"}${l.invalidReason ? ` (${l.invalidReason})` : ""}${sectorStr}`,
			);
		}

		// Must have at least outlap + 1 flying lap
		expect(laps.length).toBeGreaterThanOrEqual(2);

		// Lap 0: outlap — driver exits pit, not a valid timed lap
		expect(laps[0].invalidReason).toBe("outlap");
		expect(laps[0].isValid).toBe(false);

		// At least one flying lap between outlap and final — valid with no invalidReason
		const validLaps = laps.filter((l) => l.isValid);
		expect(validLaps.length).toBeGreaterThanOrEqual(1);
		for (const l of validLaps) {
			expect(l.invalidReason).toBeNull();
			// GT3 lap at any real circuit: 60-180s
			expect(l.lapTime).toBeGreaterThan(60);
			expect(l.lapTime).toBeLessThan(180);
			// Sector times must be populated and sum to the lap time
			assertValidLapHasSectors(l);
		}

		// Final lap: driver entered pit (inlap) or recording stopped mid-lap (incomplete)
		const last = laps[laps.length - 1];
		expect(last.isValid).toBe(false);
		expect(
			last.invalidReason === "inlap" || last.invalidReason === "incomplete",
		).toBe(true);
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

	test("sector times align with track's s1/s2 fractions and sum exactly", () => {
		if (!recording) return;
		const validLaps = laps.filter((l) => l.isValid && l.sectors);
		expect(validLaps.length).toBeGreaterThanOrEqual(1);

		for (const l of validLaps) {
			const s = l.sectors!;

			// Strict sum: stored lap time and sector sum both derive from the same
			// packet timestamps, so they must match at ms precision.
			const sumMs = Math.round((s.s1 + s.s2 + s.s3) * 1000);
			const lapMs = Math.round(l.lapTime * 1000);
			expect(sumMs).toBe(lapMs);

			// Compare measured time-fractions against the track's distance-fractions.
			// Time and distance diverge due to speed profile (slow corners inflate
			// time in one sector), so allow a wide ±0.12 absolute tolerance. This
			// still catches a collapsed/miscomputed boundary (e.g. s1 taking 80% of
			// lap time when the split is at 31% of distance).
			const trackOrdinal = l.packets[0].TrackOrdinal ?? 0;
			const meta = getTrackSectorsByOrdinal(trackOrdinal);
			const s1Frac = s.s1 / l.lapTime;
			const s12Frac = (s.s1 + s.s2) / l.lapTime;
			expect(Math.abs(s1Frac - meta.s1End)).toBeLessThan(0.12);
			expect(Math.abs(s12Frac - meta.s2End)).toBeLessThan(0.12);
		}

		// Consistency across valid laps: same sector should not vary by more than
		// 10s (catches a bad boundary/reset on one lap).
		if (validLaps.length >= 2) {
			for (const key of ["s1", "s2", "s3"] as const) {
				const values = validLaps.map((l) => l.sectors![key]);
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
