import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as fzstd from "fzstd";
import { findSteamInstall } from "../../../../server/games/shared/steam-install";
import { USER_TRACKS_DIR } from "../../../../shared/platform/runtime/data-paths";
import { bundledGeometryPath, getTrackAssetIdentity } from "../../../../shared/racing/tracks/storage/assets";
import { parseBxml, type BxmlGate } from "./bxml";
import { applyAlignment, alignGeometry, type Point } from "./geometry-alignment";
import { extractMatchingErpFragments } from "./erp";
import { parseTrackSpaceSpline, type TrackSpacePoint } from "./trackspace-spline";

const TRACK_DIR_TO_ID: Record<string, number> = {
  melbourne: 0,
  shanghai: 2,
  bahrain: 3,
  catalunya: 4,
  monaco: 5,
  montreal: 6,
  silverstone: 7,
  hungaroring: 9,
  spa_francorchamps: 10,
  monza: 11,
  singapore: 12,
  suzuka: 13,
  abu_dhabi: 14,
  texas: 15,
  brazil: 16,
  austria: 17,
  mexico: 19,
  baku: 20,
  zandvoort: 26,
  imola: 27,
  jeddah: 29,
  miami: 30,
  las_vegas: 31,
  losail: 32,
};

function readErpAndExtract(erpPath: string, resourcePattern: string): Buffer[] {
  const buffer = Buffer.from(readFileSync(erpPath));
  return extractMatchingErpFragments(buffer, resourcePattern).map(({ fragment, data }) => {
    if (fragment.compression === 0x11 || fragment.compression === 0x10 || fragment.compression === 0x03) {
      return Buffer.from(fzstd.decompress(new Uint8Array(data)));
    }
    return Buffer.from(data);
  });
}

function loadTelemetryOutline(trackId: number): Point[] | null {
  const filePath = join(USER_TRACKS_DIR, "f1-2025", `recorded-${trackId}.csv`);
  if (!existsSync(filePath)) return null;
  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean).slice(1);
  const points = lines.map((line) => {
    const [x, z] = line.split(",").map(Number);
    return { x, z };
  });
  if (points.length <= 20) return null;

  const deduped: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].x !== points[i - 1].x || points[i].z !== points[i - 1].z) deduped.push(points[i]);
  }

  const distances: number[] = [];
  for (let i = 1; i < deduped.length; i++) distances.push(Math.hypot(deduped[i].x - deduped[i - 1].x, deduped[i].z - deduped[i - 1].z));
  distances.sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)];
  const jumpThreshold = Math.max(median * 10, 100);

  let bestStart = 0;
  let bestLength = 1;
  let currentStart = 0;
  let currentLength = 1;
  for (let i = 1; i < deduped.length; i++) {
    if (Math.hypot(deduped[i].x - deduped[i - 1].x, deduped[i].z - deduped[i - 1].z) > jumpThreshold) {
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      currentStart = i;
      currentLength = 1;
    } else {
      currentLength++;
    }
  }
  if (currentLength > bestLength) {
    bestStart = currentStart;
    bestLength = currentLength;
  }
  const cleaned = deduped.slice(bestStart, bestStart + bestLength);
  return cleaned.length > 20 ? cleaned : null;
}

function gateOffset(gate: BxmlGate, type: string): Point {
  const length = gate.waypoints.find((waypoint) => waypoint.type === type)?.length ?? 0;
  return { x: gate.position.x + gate.normal.x * length, z: gate.position.z + gate.normal.z * length };
}

export function runTrackExtraction(_repoRoot: string): void {
  const f1Dir = findSteamInstall("F1 25");
  if (!f1Dir) {
    console.error("F1 25 not found. Make sure it's installed via Steam.");
    process.exit(1);
  }
  const tracksDir = join(f1Dir, "2025_asset_groups", "environment_package", "tracks");

  const trackDirs = readdirSync(tracksDir).filter((directory) => {
    try {
      return statSync(join(tracksDir, directory)).isDirectory();
    } catch {
      return false;
    }
  });

  console.log(`F1 25 track extraction — ${trackDirs.length} directories found\n`);
  let extracted = 0;

  for (const trackDir of trackDirs) {
    const trackId = TRACK_DIR_TO_ID[trackDir];
    if (trackId === undefined) {
      console.log(`  [skip] ${trackDir} — no track ID mapping`);
      continue;
    }

    const wepErp = join(tracksDir, trackDir, "wep", `${trackDir}_common.erp`);
    if (!existsSync(wepErp)) {
      console.log(`  [skip] ${trackDir} — no wep ERP`);
      continue;
    }

    process.stdout.write(`  ${trackDir} (id ${trackId})... `);
    try {
      const aisplineFragments = readErpAndExtract(wepErp, "aispline");
      const trackSpaceFragments = readErpAndExtract(wepErp, "trackspacespline");
      if (aisplineFragments.length === 0) {
        console.log("no aispline");
        continue;
      }

      const allGates = parseBxml(aisplineFragments[0]);
      const pitGates = allGates.filter((gate) => gate.name.includes("pit"));
      const trackGates = allGates.filter((gate) => !gate.name.includes("pit"));
      if (trackGates.length < 10) {
        console.log(`only ${trackGates.length} gates`);
        continue;
      }

      let tssMain: TrackSpacePoint[] = [];
      let tssPit: TrackSpacePoint[] = [];
      if (trackSpaceFragments.length > 0) {
        const spline = parseTrackSpaceSpline(trackSpaceFragments[0]);
        tssMain = spline.maintrack;
        tssPit = spline.pit;
      }

      const gateLeft: Point[] = [];
      const gateRight: Point[] = [];
      const gateRacingLine: Point[] = [];
      const gateAltitude: number[] = [];
      for (const gate of trackGates) {
        gateAltitude.push(gate.position.y);
        gateLeft.push(gateOffset(gate, "left_track_limit"));
        gateRight.push(gateOffset(gate, "right_track_limit"));
        gateRacingLine.push(gateOffset(gate, "racing_line"));
      }

      let centerline: Point[];
      let leftEdge: Point[];
      let rightEdge: Point[];
      let racingLine: Point[];
      let altitude: number[];
      if (tssMain.length > 20) {
        centerline = tssMain.map(({ x, z }) => ({ x, z }));
        altitude = tssMain.map(({ y }) => y);
        leftEdge = [];
        rightEdge = [];
        racingLine = [];
        for (const tssPoint of tssMain) {
          let nearest = 0;
          let nearestDistance = Infinity;
          for (let gateIndex = 0; gateIndex < trackGates.length; gateIndex++) {
            const distance = (tssPoint.x - trackGates[gateIndex].position.x) ** 2 + (tssPoint.z - trackGates[gateIndex].position.z) ** 2;
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearest = gateIndex;
            }
          }
          const previous = nearest > 0 ? nearest - 1 : trackGates.length - 1;
          const next = nearest < trackGates.length - 1 ? nearest + 1 : 0;
          const previousDistance = (tssPoint.x - trackGates[previous].position.x) ** 2 + (tssPoint.z - trackGates[previous].position.z) ** 2;
          const nextDistance = (tssPoint.x - trackGates[next].position.x) ** 2 + (tssPoint.z - trackGates[next].position.z) ** 2;
          const adjacent = previousDistance < nextDistance ? previous : next;
          const d0 = Math.hypot(tssPoint.x - trackGates[nearest].position.x, tssPoint.z - trackGates[nearest].position.z);
          const d1 = Math.hypot(tssPoint.x - trackGates[adjacent].position.x, tssPoint.z - trackGates[adjacent].position.z);
          const total = d0 + d1;
          const ratio = total > 0 ? d0 / total : 0;
          const lerp = (a: number, b: number) => a * (1 - ratio) + b * ratio;
          leftEdge.push({ x: lerp(gateLeft[nearest].x, gateLeft[adjacent].x), z: lerp(gateLeft[nearest].z, gateLeft[adjacent].z) });
          rightEdge.push({ x: lerp(gateRight[nearest].x, gateRight[adjacent].x), z: lerp(gateRight[nearest].z, gateRight[adjacent].z) });
          racingLine.push({ x: lerp(gateRacingLine[nearest].x, gateRacingLine[adjacent].x), z: lerp(gateRacingLine[nearest].z, gateRacingLine[adjacent].z) });
        }
        process.stdout.write(`tss=${tssMain.length} `);
      } else {
        centerline = gateLeft.map((left, i) => ({ x: (left.x + gateRight[i].x) / 2, z: (left.z + gateRight[i].z) / 2 }));
        leftEdge = [...gateLeft];
        rightEdge = [...gateRight];
        racingLine = [...gateRacingLine];
        altitude = [...gateAltitude];
      }

      let pitLane: Point[] | null = tssPit.length > 5 ? tssPit.map(({ x, z }) => ({ x, z })) : pitGates.length > 5 ? pitGates.map(({ position }) => ({ x: position.x, z: position.z })) : null;
      const telemetryOutline = loadTelemetryOutline(trackId);
      let aligned = false;
      if (telemetryOutline) {
        const alignment = alignGeometry(centerline, telemetryOutline);
        if (alignment.error > 35) {
          process.stdout.write("[alignment too poor, skipping] ");
        } else {
          const apply = (point: Point) => applyAlignment(point, alignment);
          centerline = centerline.map(apply);
          leftEdge = leftEdge.map(apply);
          rightEdge = rightEdge.map(apply);
          racingLine = racingLine.map(apply);
          if (pitLane) pitLane = pitLane.map(apply);
          if (alignment.flip === "flipX" || alignment.flip === "flipXZ") [leftEdge, rightEdge] = [rightEdge, leftEdge];
          aligned = true;
        }
        const flip = alignment.flip ? ` ${alignment.flip}` : "";
        process.stdout.write(`[tel] s=${alignment.transform.scale.toFixed(3)} r=${((alignment.transform.rotation * 180) / Math.PI).toFixed(1)}°${flip} err=${alignment.error.toFixed(1)}m `);
      }

      let cutIndex = centerline.length;
      for (let i = 1; i < centerline.length; i++) {
        if (Math.hypot(centerline[i].x - centerline[i - 1].x, centerline[i].z - centerline[i - 1].z) > 100) {
          for (let j = 0; j < i - 5; j++) {
            if (Math.hypot(centerline[i].x - centerline[j].x, centerline[i].z - centerline[j].z) < 20) {
              cutIndex = i;
              break;
            }
          }
          if (cutIndex < centerline.length) break;
        }
      }
      if (cutIndex < centerline.length) {
        centerline.length = cutIndex;
        leftEdge.length = cutIndex;
        rightEdge.length = cutIndex;
        racingLine.length = cutIndex;
        altitude.length = cutIndex;
        if (pitLane && pitLane.length > cutIndex) pitLane.length = cutIndex;
        process.stdout.write(`[trimmed ${cutIndex}] `);
      }

      const negateX = (point: Point) => ({ x: -point.x, z: point.z });
      centerline = centerline.map(negateX);
      leftEdge = leftEdge.map(negateX);
      rightEdge = rightEdge.map(negateX);
      racingLine = racingLine.map(negateX);
      if (pitLane) pitLane = pitLane.map(negateX);
      [leftEdge, rightEdge] = [rightEdge, leftEdge];

      const identity = getTrackAssetIdentity("f1-2025", trackId);
      if (!identity) {
        console.log("no canonical registry assignment");
        continue;
      }
      const centerlinePath = bundledGeometryPath(identity, "centerline");
      mkdirSync(dirname(centerlinePath), { recursive: true });
      writeFileSync(centerlinePath, ["x,z", ...centerline.map((point) => `${point.x.toFixed(4)},${point.z.toFixed(4)}`)].join("\n"));
      writeFileSync(bundledGeometryPath(identity, "boundaries"), JSON.stringify({ waypoints: trackGates.length, leftEdge, rightEdge, altitude, pitLane }, null, 2));
      console.log(`${trackGates.length} gates, ${pitGates.length} pit${aligned ? " [aligned]" : ""} → ${identity.venuePath}/${identity.layoutSlug}`);
      extracted++;
    } catch (error) {
      console.log(`error: ${(error as Error).message}`);
    }
  }

  console.log(`\nExtracted ${extracted} tracks to canonical venue geometry`);
}
