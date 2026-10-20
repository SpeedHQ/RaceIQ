import { m } from "@/paraglide/messages";
import { useMemo, useSyncExternalStore } from "react";
import type { SpectateController, SpectatePair, SpectateSegment } from "./types";
import { focusRuns, type SpectateFocus } from "./spectate-focus";

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
/** Interpolate boundary times on the physical-distance grid, never sample indices. */
function splitLookup(pair: SpectatePair) {
  const { distance, elapsedTimeA, elapsedTimeB } = pair.comparison.traces;
  const valid = distance.length > 1 && [elapsedTimeA, elapsedTimeB].every((times) =>
    times.length === distance.length && times.every((time, index) =>
      Number.isFinite(time) && Number.isFinite(distance[index]) &&
      (index === 0 || (time >= times[index - 1] && distance[index] > distance[index - 1]))));
  const maximum = distance.at(-1) ?? 0;
  const at = (times: number[], target: number): number | null => {
    if (!valid || target < distance[0] || target > maximum) return null;
    let low = 0, high = distance.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (distance[middle] < target) low = middle + 1;
      else high = middle;
    }
    if (distance[low] === target) return times[low];
    const before = low - 1;
    return times[before] + (times[low] - times[before]) * (target - distance[before]) / (distance[low] - distance[before]);
  };
  return (segment: SpectateSegment) => {
    const duration = (times: number[]) => {
      const start = at(times, segment.startFrac * maximum), end = at(times, segment.endFrac * maximum);
      if (start === null || end === null) return null;
      if (segment.endFrac >= segment.startFrac) return end - start;
      const first = at(times, 0), last = at(times, maximum);
      return first === null || last === null ? null : last - start + end - first;
    };
    const a = duration(elapsedTimeA), b = duration(elapsedTimeB);
    return a === null || b === null ? null : Math.round((a - b) * 1000) / 1000;
  };
}
function splitColor(delta: number | null) {
  return delta === null || delta === 0 ? "var(--app-text-secondary)" : delta < 0 ? "var(--status-success)" : "var(--status-danger)";
}
function splitText(delta: number | null) {
  return delta === null ? m.analyse_unavailable() : `${delta > 0 ? "+" : ""}${delta.toFixed(3)} s`;
}

export function SpectateOverview({ pair, controller, segments, focus }: { pair: SpectatePair; controller: SpectateController; segments: readonly SpectateSegment[]; focus: SpectateFocus }) {
  const coloredRuns = useMemo(() => [focusRuns(pair.a.samples, focus), focusRuns(pair.b.samples, focus)], [pair, focus]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const splitAt = useMemo(() => splitLookup(pair), [pair]);
  const rows = useMemo(
    () =>
      segments
        .filter((segment) => Number.isFinite(segment.startFrac) && Number.isFinite(segment.endFrac) && segment.startFrac >= 0 && segment.startFrac <= 1 && segment.endFrac >= 0 && segment.endFrac <= 1)
        .map((segment, index) => ({ segment, number: index + 1, delta: splitAt(segment) })),
    [segments, splitAt],
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
    // Leave room for numbered markers outside the track stroke.
    const scale = Math.min(152 / (bounds.maxX - bounds.minX || 1), 60 / (bounds.maxZ - bounds.minZ || 1));
    const project = (point: { x: number; z: number }) => ({
      x: (200 - (bounds.maxX - bounds.minX) * scale) / 2 + (point.x - bounds.minX) * scale,
      y: (108 - (bounds.maxZ - bounds.minZ) * scale) / 2 + (point.z - bounds.minZ) * scale,
    });
    const projectString = (point: { x: number; z: number }) => {
      const projected = project(point);
      return `${projected.x},${projected.y}`;
    };
    const projectedRuns = runs.map((run) => run.map(project));
    const placed: { x: number; y: number }[] = [];
    const clear = (x: number, y: number) => {
      if (x < 7 || x > 193 || y < 7 || y > 101) return false;
      if (placed.some((other) => Math.hypot(x - other.x, y - other.y) < 13)) return false;
      for (const run of projectedRuns) {
        for (let i = 0; i < run.length; i++) {
          const a = run[i], b = run[Math.min(i + 1, run.length - 1)];
          const dx = b.x - a.x, dy = b.y - a.y;
          const lengthSquared = dx * dx + dy * dy;
          const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0;
          if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < 11) return false;
        }
      }
      return true;
    };
    const markers = rows.map(({ segment, number, delta }) => {
      const endFraction = segment.endFrac < segment.startFrac ? segment.endFrac + 1 : segment.endFrac;
      const fraction = ((segment.startFrac + endFraction) / 2) % 1;
      const position = positionAcrossRuns(runs, fraction * maximum);
      const anchor = position ? project(position) : null;
      let marker: { x: number; y: number } | null = null;
      if (anchor) {
        const before = positionAcrossRuns(runs, Math.max(0, fraction * maximum - maximum * 0.002));
        const after = positionAcrossRuns(runs, Math.min(maximum, fraction * maximum + maximum * 0.002));
        let nx = before && after ? -(after.z - before.z) : anchor.x - 100;
        let ny = before && after ? after.x - before.x : anchor.y - 54;
        if (nx * (anchor.x - 100) + ny * (anchor.y - 54) < 0) {
          nx = -nx;
          ny = -ny;
        }
        const angle = Math.atan2(ny, nx);
        // Search outward first, avoiding every track run and previously placed badge.
        for (let radius = 13; radius <= 200 && !marker; radius += 3) {
          for (let step = 0; step < 24; step++) {
            const offset = Math.ceil(step / 2) * (step % 2 ? 1 : -1) * Math.PI / 12;
            const x = anchor.x + Math.cos(angle + offset) * radius;
            const y = anchor.y + Math.sin(angle + offset) * radius;
            if (clear(x, y)) {
              marker = { x, y };
              placed.push(marker);
              break;
            }
          }
        }
      }
      return { number, segment, delta, anchor, position: marker, sectionPaths: segmentPaths(runs, segment.startFrac, segment.endFrac, maximum, projectString) };
    });
    return { project, paths: runs.filter((run) => run.length > 1).map((run) => run.map(projectString).join(" ")), markers };
  }, [maximum, rows, runs]);
  const projectedFocusRuns = useMemo(() => geometry ? coloredRuns.map((runs) => runs.map((run) => ({
    token: run.token,
    points: run.points.map((point) => { const p = geometry.project(point); return `${p.x},${p.y}`; }).join(" "),
  }))) : [], [coloredRuns, geometry]);
  const poseA = geometry?.project(snapshot.a?.pose ?? { x: Number.NaN, z: Number.NaN });
  const poseB = geometry?.project(snapshot.b?.pose ?? { x: Number.NaN, z: Number.NaN });
  return (
    <section
      className="absolute left-3 top-3 z-20 w-[min(360px,calc(100%-1.5rem))] rounded-md border border-app-border bg-app-bg/75 p-2.5 text-app-label text-app-text opacity-50 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none max-[600px]:w-60"
      aria-label={m.spectate_overview()}
      data-focus-mode={focus.mode}
    >
      <div className="flex items-center justify-between">
        <strong>{m.spectate_overview()}</strong>
        <span className="text-app-text-secondary max-[600px]:hidden">{m.spectate_select_segment()}</span>
      </div>
      {geometry ? (
        <svg viewBox="0 0 200 108" className="mt-2 block h-48 w-full max-[600px]:h-32" role="group" aria-label={m.spectate_segment_map()}>
          {geometry.paths.map((path, index) => (
            <polyline key={index} points={path} fill="none" stroke="var(--app-border)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {projectedFocusRuns.flatMap((runs, side) => runs.map((run, index) => (
            <polyline key={`${side}-${index}`} data-focus-lap={side === 0 ? "a" : "b"} data-focus-color={run.token}
              points={run.points}
              fill="none" stroke={`var(${run.token})`} strokeWidth={side === 0 ? "4" : "1.8"} strokeDasharray={side === 0 ? undefined : "3 2"}
              strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
          )))}
          {geometry.markers.map(({ number, segment, delta, anchor, position, sectionPaths }) => (
            <g
              key={`${number}-${segment.startFrac}`}
              role="button"
              data-segment-start={segment.startFrac}
              data-segment-end={segment.endFrac}
              data-seek-distance={segment.startFrac * maximum}
              data-split-delta={delta ?? ""}
              tabIndex={0}
              aria-label={`${m.spectate_segment_number({ number })}: ${segment.name}; A − B: ${splitText(delta)}`}
              onClick={() => controller.seekDistance(Math.max(0, Math.min(maximum, segment.startFrac * maximum)))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  controller.seekDistance(Math.max(0, Math.min(maximum, segment.startFrac * maximum)));
                }
              }}
              className="cursor-pointer outline-none focus-visible:opacity-70"
            >
              <title>{`${segment.name || m.spectate_segment_number({ number })} · A − B: ${splitText(delta)}`}</title>
              {sectionPaths.map((path, index) => (
                <polyline key={index} points={path} fill="none" stroke="transparent" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {position && (
                <>
                  {anchor && <line x1={anchor.x} y1={anchor.y} x2={position.x} y2={position.y} stroke="var(--app-text-secondary)" strokeWidth="0.6" opacity="0.5" pointerEvents="none" />}
                  <circle cx={position.x} cy={position.y} r="5.5" fill={splitColor(delta)} stroke="var(--app-bg)" strokeWidth="0.8" />
                  <text x={position.x} y={position.y} textAnchor="middle" dominantBaseline="central" fill={delta !== null && delta > 0 ? "var(--app-text)" : "var(--app-bg)"} fontSize="6" fontWeight="var(--font-weight-bold)">
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
    </section>
  );
}
