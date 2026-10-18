import { m } from "@/paraglide/messages";
import { useMemo, useSyncExternalStore } from "react";
import type { SpectateController, SpectatePair, SpectateSegment } from "./types";
import type { LapInsight, LapDetectorCoverage } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { INSIGHT_DETECTORS } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";

const palette = {
  nominal: "var(--severity-nominal)",
  info: "var(--severity-caution)",
  warning: "var(--severity-warning)",
  critical: "var(--severity-critical)",
  partial: "var(--status-unavailable)",
  unknown: "var(--status-unavailable)",
};
function issueText(state: keyof typeof palette) {
  if (state === "info") return m.spectate_issue_info();
  if (state === "warning") return m.spectate_issue_warning();
  if (state === "critical") return m.spectate_issue_critical();
  if (state === "unknown") return m.spectate_coverage_unavailable();
  if (state === "partial") return m.spectate_coverage_partial();
  return m.spectate_checked();
}
type Finding = Pick<LapInsight, "id" | "severity" | "label" | "detail" | "frameIndices">;
type Coverage = Pick<LapDetectorCoverage, "id" | "status">;
type DistanceRange = readonly [number, number];
type DistanceLookup = (packet: number) => DistanceRange | null;
function packetDistanceLookup(pair: SpectatePair, side: "a" | "b"): DistanceLookup {
  const trace = pair.comparison.traces;
  const indices = side === "a" ? trace.sourceIndicesA : trace.sourceIndicesB;
  const distances = trace.distance;
  if (!indices.length || distances.length !== indices.length) return () => null;
  for (let index = 0; index < indices.length; index++) {
    if (!Number.isInteger(indices[index]) || !Number.isFinite(distances[index]) || (index > 0 && (indices[index] < indices[index - 1] || distances[index] < distances[index - 1]))) return () => null;
  }
  return (packet) => {
    if (!Number.isInteger(packet) || packet < indices[0] || packet > indices[indices.length - 1]) return null;
    let low = 0,
      high = indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indices[middle] < packet) low = middle + 1;
      else high = middle;
    }
    if (indices[low] === packet) {
      let end = low;
      while (end + 1 < indices.length && indices[end + 1] === packet) end++;
      return [distances[low], distances[end]];
    }
    if (low === 0 || low === indices.length) return null;
    const before = low - 1,
      span = indices[low] - indices[before];
    if (span <= 0) return null;
    const fraction = (packet - indices[before]) / span;
    const distance = distances[before] + (distances[low] - distances[before]) * fraction;
    return Number.isFinite(distance) ? [distance, distance] : null;
  };
}
function rangeOverlapsSegment(range: DistanceRange, start: number, end: number, origin: number, length: number) {
  if (!(length > 0)) return false;
  const lower = (range[0] - origin) / length,
    upper = (range[1] - origin) / length;
  const overlaps = (from: number, to: number) => (lower < to || (to === 1 && lower <= 1)) && upper >= from;
  return end < start ? overlaps(start, 1) || overlaps(0, end) : overlaps(start, end);
}
function issueAt(pair: SpectatePair, segment: SpectateSegment, lookup: Record<"a" | "b", DistanceLookup>) {
  const grid = pair.comparison.traces.distance;
  const origin = grid[0] ?? 0;
  const length = grid.length > 1 ? grid[grid.length - 1] - origin : 0;
  const relevant: { side: "a" | "b"; finding: Finding }[] = [];
  const unlocated: { side: "a" | "b"; finding: Finding }[] = [];
  let invalidFinding = false;
  for (const side of ["a", "b"] as const) {
    const raw = pair[side].replay.insights;
    if (!Array.isArray(raw)) {
      invalidFinding = true;
      continue;
    }
    for (const finding of raw as Finding[]) {
      if (
        !finding ||
        typeof finding.id !== "string" ||
        !["info", "warning", "critical"].includes(finding.severity) ||
        typeof finding.label !== "string" ||
        typeof finding.detail !== "string" ||
        !Array.isArray(finding.frameIndices) ||
        !finding.frameIndices.every(Number.isInteger)
      ) {
        invalidFinding = true;
        continue;
      }
      // These detectors summarize lap-wide consumption or averaged axle balance.
      // Their evidence packet is not the location of a fault.
      if (["mech-fuel", "tire-wear-imbalance", "tire-temp-split", "tire-pressure-imbalance", "susp-imbalance"].includes(finding.id)) {
        unlocated.push({ side, finding });
        continue;
      }
      const positions = finding.frameIndices.map((frame) => lookup[side](frame)).filter((range): range is DistanceRange => range !== null);
      if (positions.length === 0) {
        invalidFinding = true;
        unlocated.push({ side, finding });
        continue;
      }
      if (positions.some((range) => rangeOverlapsSegment(range, segment.startFrac, segment.endFrac, origin, length))) relevant.push({ side, finding });
    }
  }
  const coverage = (["a", "b"] as const).map((side) => {
    const raw = pair[side].replay.detectorCoverage;
    if (!Array.isArray(raw) || raw.some((item) => !["finding", "checked", "unavailable"].includes(item.status))) return null;
    const statuses = (raw as Coverage[]).map((item) => item.status);
    const present = new Set(raw.map((item) => item.id));
    if (INSIGHT_DETECTORS.some((detector) => !present.has(detector.id))) statuses.push("unavailable");
    return statuses;
  });
  const checked = coverage.some((items) => items?.includes("checked") || items?.includes("finding"));
  const unavailable = coverage.some((items) => items === null || items.length === 0 || items.includes("unavailable"));
  const severity = relevant.reduce<"info" | "warning" | "critical" | null>((best, entry) => {
    const value = entry.finding.severity;
    if (value === "critical" || (value === "warning" && best !== "critical") || (value === "info" && best === null)) return value;
    return best;
  }, null);
  const state: keyof typeof palette = severity ?? (unavailable || invalidFinding ? (checked ? "partial" : "unknown") : checked ? "nominal" : "unknown");
  return { relevant, unlocated, state };
}
type TrackPoint = { distance: number; run: number; x: number; z: number };
function trackRuns(pair: SpectatePair): TrackPoint[][] {
  const runs: TrackPoint[][] = [];
  let current: TrackPoint[] = [];
  let prior: TrackPoint | null = null;
  for (const sample of pair.a.samples) {
    const x = sample.values["motion.position-x"],
      z = sample.values["motion.position-z"];
    if (!Number.isFinite(sample.distance) || !Number.isFinite(x) || !Number.isFinite(z)) {
      if (current.length) runs.push(current);
      current = [];
      prior = null;
      continue;
    }
    const point = { distance: sample.distance, run: sample.run, x: x as number, z: z as number };
    if (prior && (prior.run !== point.run || point.distance < prior.distance)) {
      if (current.length) runs.push(current);
      current = [];
    }
    current.push(point);
    prior = point;
  }
  if (current.length) runs.push(current);
  return runs;
}
function positionAtDistance(points: readonly TrackPoint[], target: number) {
  if (!points.length || target < points[0].distance || target > points[points.length - 1].distance) return null;
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].distance < target) low = middle + 1;
    else high = middle;
  }
  const after = Math.min(points.length - 1, low);
  if (points[after].distance === target || after === 0) return points[after];
  const before = points[after - 1],
    next = points[after],
    span = next.distance - before.distance;
  if (span <= 0) return before;
  const fraction = (target - before.distance) / span;
  return { x: before.x + (next.x - before.x) * fraction, z: before.z + (next.z - before.z) * fraction };
}
function positionAcrossRuns(runs: readonly TrackPoint[][], target: number) {
  for (const run of runs) {
    const position = positionAtDistance(run, target);
    if (position) return position;
  }
  return null;
}
function segmentPaths(runs: readonly TrackPoint[][], start: number, end: number, maximum: number, project: (point: { x: number; z: number }) => string) {
  const startDistance = start * maximum,
    endDistance = end * maximum;
  const intervals: [number, number][] =
    end < start
      ? [
          [startDistance, maximum],
          [0, endDistance],
        ]
      : [[startDistance, endDistance]];
  return intervals.flatMap(([from, to]) =>
    runs.flatMap((run) => {
      const positions: { x: number; z: number }[] = [];
      const first = positionAtDistance(run, from),
        last = positionAtDistance(run, to);
      if (first) positions.push(first);
      for (const sample of run) if (sample.distance > from && sample.distance < to) positions.push(sample);
      if (last && (positions.length === 0 || positions[positions.length - 1] !== last)) positions.push(last);
      return positions.length >= 2 ? [positions.map(project).join(" ")] : [];
    }),
  );
}
export function SpectateOverview({ pair, controller, segments }: { pair: SpectatePair; controller: SpectateController; segments: readonly SpectateSegment[] }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const lookup = useMemo(() => ({ a: packetDistanceLookup(pair, "a"), b: packetDistanceLookup(pair, "b") }), [pair]);
  const rows = useMemo(
    () =>
      segments
        .filter((segment) => Number.isFinite(segment.startFrac) && Number.isFinite(segment.endFrac) && segment.startFrac >= 0 && segment.startFrac <= 1 && segment.endFrac >= 0 && segment.endFrac <= 1)
        .map((segment, index) => ({ segment, number: segment.number ?? index + 1, issue: issueAt(pair, segment, lookup) })),
    [lookup, pair, segments],
  );
  const runs = useMemo(() => trackRuns(pair), [pair]);
  const maximum = pair.comparison.traces.distance.at(-1) ?? pair.a.distance;
  const geometry = useMemo(() => {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    let pointCount = 0;
    for (const run of runs)
      for (const point of run) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
        pointCount++;
      }
    if (pointCount < 2 || !pair.a.hasProgress || !(maximum > 0)) return null;
    const bounds = { minX, maxX, minZ, maxZ };
    const scale = Math.min(184 / (bounds.maxX - bounds.minX || 1), 92 / (bounds.maxZ - bounds.minZ || 1));
    const project = (point: { x: number; z: number }) => ({
      x: (200 - (bounds.maxX - bounds.minX) * scale) / 2 + (point.x - bounds.minX) * scale,
      y: (108 - (bounds.maxZ - bounds.minZ) * scale) / 2 + (point.z - bounds.minZ) * scale,
    });
    const projectString = (point: { x: number; z: number }) => {
      const projected = project(point);
      return `${projected.x},${projected.y}`;
    };
    const markers = rows.map(({ segment, number, issue }) => {
      const endFraction = segment.endFrac < segment.startFrac ? segment.endFrac + 1 : segment.endFrac;
      const fraction = ((segment.startFrac + endFraction) / 2) % 1;
      const position = positionAcrossRuns(runs, fraction * maximum);
      return { number, segment, issue, position: position ? project(position) : null, sectionPaths: segmentPaths(runs, segment.startFrac, segment.endFrac, maximum, projectString) };
    });
    return { project, paths: runs.filter((run) => run.length > 1).map((run) => run.map(projectString).join(" ")), markers };
  }, [maximum, rows, runs]);
  const poseA = geometry?.project(snapshot.a?.pose ?? { x: Number.NaN, z: Number.NaN });
  const poseB = geometry?.project(snapshot.b?.pose ?? { x: Number.NaN, z: Number.NaN });
  const findings = rows.flatMap(({ issue, segment, number }) =>
    issue.relevant.map(({ side, finding }) => `${side.toUpperCase()}: ${finding.label} — ${finding.detail} (${segment.name || m.spectate_segment_number({ number })})`),
  );
  const unlocated = rows
    .flatMap(({ issue }) => issue.unlocated.map(({ side, finding }) => `${side.toUpperCase()}: ${finding.label} — ${finding.detail}`))
    .filter((entry, index, all) => all.indexOf(entry) === index);
  return (
    <section
      className="absolute left-3 top-3 z-20 w-[min(228px,calc(100%-1.5rem))] rounded-md border border-app-border bg-app-bg/75 p-2.5 text-app-label text-app-text max-[600px]:w-44"
      aria-label={m.spectate_overview()}
    >
      <div className="flex items-center justify-between">
        <strong>{m.spectate_overview()}</strong>
        <span className="text-app-text-secondary max-[600px]:hidden">{m.spectate_select_segment()}</span>
      </div>
      {geometry ? (
        <svg viewBox="0 0 200 108" className="mt-2 block h-28 w-full max-[600px]:h-20" role="group" aria-label={m.spectate_segment_map()}>
          {geometry.paths.map((path, index) => (
            <polyline key={index} points={path} fill="none" stroke="var(--app-border)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {geometry.markers.map(({ number, segment, issue, position, sectionPaths }) => (
            <g
              key={`${number}-${segment.startFrac}`}
              role="button"
              data-segment-start={segment.startFrac}
              data-segment-end={segment.endFrac}
              data-seek-distance={segment.startFrac * maximum}
              data-issue-state={issue.state}
              data-insight-ids={issue.relevant.map(({ finding }) => finding.id).join(",")}
              tabIndex={0}
              aria-label={`${m.spectate_segment_number({ number })}: ${segment.name}; ${issueText(issue.state)} ${[...new Set(issue.relevant.map(({ side }) => side.toUpperCase()))].join("/")}`}
              onClick={() => controller.seekDistance(Math.max(0, Math.min(maximum, segment.startFrac * maximum)))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  controller.seekDistance(Math.max(0, Math.min(maximum, segment.startFrac * maximum)));
                }
              }}
              className="cursor-pointer outline-none focus-visible:opacity-70"
            >
              {sectionPaths.map((path, index) => (
                <polyline key={index} points={path} fill="none" stroke="transparent" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {sectionPaths.map((path, index) => (
                <polyline key={index} points={path} fill="none" stroke={palette[issue.state]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {position && (
                <>
                  <circle cx={position.x} cy={position.y} r="7" fill={palette[issue.state]} stroke="var(--app-bg)" strokeWidth="1" />
                  <text x={position.x} y={position.y} textAnchor="middle" dominantBaseline="central" fill="var(--app-bg)" fontSize="8" fontWeight="var(--font-weight-bold)">
                    {number}
                  </text>
                </>
              )}
            </g>
          ))}
          {poseA && Number.isFinite(poseA.x) && Number.isFinite(poseA.y) && (
            <circle role="img" aria-label="A" cx={poseA.x} cy={poseA.y} r="3.5" fill="var(--comparison-lap-a)" stroke="var(--app-bg)" strokeWidth="1.5">
              <title>A</title>
            </circle>
          )}
          {poseB && Number.isFinite(poseB.x) && Number.isFinite(poseB.y) && (
            <circle role="img" aria-label="B" cx={poseB.x} cy={poseB.y} r="3.5" fill="var(--comparison-lap-b)" stroke="var(--app-bg)" strokeWidth="1.5">
              <title>B</title>
            </circle>
          )}
        </svg>
      ) : (
        <div className="my-2 flex h-24 items-center justify-center border-y border-app-border text-app-text-secondary">{m.spectate_geometry_unavailable()}</div>
      )}
      <ul className="max-h-20 space-y-1 overflow-auto max-[600px]:hidden">
        {rows.map(({ segment, number, issue }) => (
          <li key={`${number}-${segment.name}`} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette[issue.state] }} />
            <span className="truncate">
              {number}. {segment.name}
            </span>
            <span className="ml-auto text-app-text-secondary">
              {issue.relevant.length
                ? `${issue.relevant
                    .map((entry) => entry.side.toUpperCase())
                    .filter((value, index, all) => all.indexOf(value) === index)
                    .join("/")}: ${issueText(issue.state)}`
                : issueText(issue.state)}
            </span>
          </li>
        ))}
      </ul>
      {(findings.length > 0 || unlocated.length > 0) && (
        <details className="mt-2 text-app-text-secondary">
          <summary className="cursor-pointer text-app-accent">{m.analyse_tab_insights()}</summary>
          <p className="max-h-28 overflow-y-auto pt-1">{[...findings, ...unlocated.map((finding) => `${finding} (${m.spectate_unlocated()})`)].join(" · ")}</p>
        </details>
      )}
      <div tabIndex={0} aria-label={m.insight_checks()} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-app-text-secondary max-[600px]:max-h-8 max-[600px]:overflow-y-auto">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: palette.nominal }} />
          {m.spectate_checked()}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: palette.info }} />
          {m.spectate_issue_info()}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: palette.warning }} />
          {m.spectate_issue_warning()}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: palette.critical }} />
          {m.spectate_issue_critical()}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: palette.partial }} />
          {m.spectate_coverage_partial()}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: palette.unknown }} />
          {m.spectate_coverage_unavailable()}
        </span>
      </div>
    </section>
  );
}
