/**
 * Raw driving observations for a pool of laps, rendered for a prompt.
 *
 * This is the *presentation* half of `server/lap-analysis/metrics.ts` and inherits its
 * central rule (issue #120): an observation is a concrete fact about how a lap
 * was driven, and nothing more.
 *
 * ⚠️ Deliberately knows nothing about tuning tests, hypotheses, verdicts,
 * baseline arms, or what the driver is currently trying to fix. It takes
 * `LapMetrics[]` and returns numbers with corner names attached. It does not
 * label anything a problem, does not rank corners by "time lost", and does not
 * say whether a change helped — every one of those needs a question to be asked
 * first, and the whole point of this layer is that the same block is valid no
 * matter what question the agent is answering. The agent reads these facts,
 * combines them with the experiment frame (which lives in version history) and
 * does the recommending.
 *
 * Consequence for ordering: corners are printed in track order and, when the
 * list must be truncated to bound the prompt, kept by time spent in them — a
 * property of the lap, not of anyone's theory about it.
 */

import type { LapMetrics, SegmentStat } from "../lap-analysis/metrics"

/** Default cap on printed corners, to bound the prompt. */
const MAX_CORNERS = 12;

function median(values: number[]): number | null {
	const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	if (!nums.length) return null;
	const mid = Math.floor(nums.length / 2);
	return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function fmt(value: number | null, digits: number, unit = ""): string {
	return value == null ? "n/a" : `${value.toFixed(digits)}${unit}`;
}

/** A segment identity shared across laps — curated `name` is stable per track. */
function segmentKey(seg: SegmentStat): string {
	return `${seg.type}:${seg.name}`;
}

/**
 * Roll the per-lap `insights` up into "how often did this show up", so a
 * one-off blunder reads differently from a habit. Grouped by `label` because
 * `id` is per-event.
 */
function formatRecurringInsights(metrics: LapMetrics[]): string {
	const lapCount = metrics.length;
	const byLabel = new Map<string, { laps: Set<number>; detail: string; severity: string }>();

	for (const m of metrics) {
		for (const ins of m.insights) {
			const existing = byLabel.get(ins.label);
			if (existing) {
				existing.laps.add(m.lapId);
			} else {
				byLabel.set(ins.label, { laps: new Set([m.lapId]), detail: ins.detail, severity: ins.severity });
			}
		}
	}

	if (!byLabel.size) return "No detector fired on these laps.";

	return [...byLabel.entries()]
		.sort((a, b) => b[1].laps.size - a[1].laps.size)
		.map(([label, v]) => `${label} [${v.severity}] — ${v.laps.size}/${lapCount} laps: ${v.detail}`)
		.join("\n");
}

/**
 * Per-corner numbers, median across the pool. Median rather than mean so one
 * scruffy lap does not drag a corner's numbers somewhere no lap actually was.
 */
function formatCornerFacts(metrics: LapMetrics[], maxCorners: number): string {
	if (!metrics.length) return "No lap metrics available.";

	// Group each lap's segments by curated identity. Track order is taken from
	// the first lap that has the segment (startFrac is a track property).
	const groups = new Map<string, { seg: SegmentStat; instances: SegmentStat[] }>();
	for (const m of metrics) {
		for (const seg of m.segmentStats) {
			if (seg.type !== "corner") continue;
			const key = segmentKey(seg);
			const existing = groups.get(key);
			if (existing) existing.instances.push(seg);
			else groups.set(key, { seg, instances: [seg] });
		}
	}
	if (!groups.size) return "This track has no curated corner geometry, so no per-corner breakdown.";

	const rows = [...groups.values()].map((g) => ({
		seg: g.seg,
		n: g.instances.length,
		timeSec: median(g.instances.map((s) => s.timeSec)),
		minSpeed: median(g.instances.map((s) => s.stats.minSpeed)),
		brakeOnDist: median(g.instances.map((s) => s.stats.brakeOnDist).filter((v): v is number => v != null)),
		peakBrake: median(g.instances.map((s) => s.stats.peakBrakeValue)),
		brakeApplications: median(g.instances.map((s) => s.stats.brakeApplications)),
		fullThrottlePctDist: median(g.instances.map((s) => s.stats.fullThrottlePctDist)),
		steeringSmoothness: median(g.instances.map((s) => s.stats.steeringSmoothness)),
	}));

	// Bound the prompt by time spent (a fact about the lap), then restore track
	// order for reading. Truncation is stated rather than silent.
	const truncated = rows.length > maxCorners;
	const kept = truncated
		? [...rows].sort((a, b) => (b.timeSec ?? 0) - (a.timeSec ?? 0)).slice(0, maxCorners)
		: rows;
	kept.sort((a, b) => a.seg.startFrac - b.seg.startFrac);

	const lines = kept.map((r) => {
		const label = r.seg.number != null ? `T${r.seg.number} ${r.seg.name}` : r.seg.name;
		return (
			`${label}: ${fmt(r.timeSec, 2, "s")}, minSpeed ${fmt(r.minSpeed, 0, "km/h")}, ` +
			`brakeOn ${fmt(r.brakeOnDist, 0, "m")}, peakBrake ${fmt(r.peakBrake, 2)}, ` +
			`brakeApps ${fmt(r.brakeApplications, 1)}, fullThrottle ${fmt(r.fullThrottlePctDist == null ? null : r.fullThrottlePctDist * 100, 0, "%")}, ` +
			`steerSmooth ${fmt(r.steeringSmoothness, 3)}`
		);
	});

	if (truncated) {
		lines.push(`(${rows.length - maxCorners} further corners omitted — longest ${maxCorners} by time shown)`);
	}
	return lines.join("\n");
}

/**
 * Render the observations block. `metrics` is the clean-lap pool; order does
 * not matter (everything is aggregated by median or by recurrence count).
 */
export function formatLapObservations(metrics: LapMetrics[], maxCorners = MAX_CORNERS): string {
	if (!metrics.length) {
		return "No analysable laps yet — no driving observations available.";
	}
	return [
		`Concrete, per-lap facts over ${metrics.length} clean lap(s). Distances are metres from the start ` +
			`of the lap; speeds km/h; brake/throttle 0..1 unless marked %. These are measurements, not ` +
			`diagnoses — interpret them yourself against what the driver reports.`,
		`RECURRING TECHNIQUE FLAGS:\n${formatRecurringInsights(metrics)}`,
		`PER-CORNER (median across the pool):\n${formatCornerFacts(metrics, maxCorners)}`,
	].join("\n\n");
}
