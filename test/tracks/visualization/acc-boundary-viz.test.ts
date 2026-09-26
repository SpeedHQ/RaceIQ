import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initGameAdapters } from "../../../shared/games/init";
import { getAccTracks } from "../../../shared/racing/tracks/catalogs/acc";
import { flipPoints, needsTrackFlip } from "../../../shared/racing/tracks/coords";
import { getTrackBoundariesByOrdinal } from "../../../shared/racing/tracks/geometry/extracted";
import { makeTrackProjection, type Pt } from "../../../shared/racing/tracks/projection";
import { getTrackRacelineByOrdinal } from "../../../shared/racing/tracks/recording/outlines";
import { getBundledTrackName } from "../../../shared/racing/tracks/resolve-name";

initGameAdapters();

const outputDir = resolve(import.meta.dir, "../../e2e/output/acc-boundaries");
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const tracks = new Map<string, number>();
for (const ordinal of getAccTracks().keys()) {
  const slug = getBundledTrackName("acc", ordinal);
  if (slug && !tracks.has(slug)) tracks.set(slug, ordinal);
}

for (const [slug, ordinal] of tracks) {
  test(`${slug} renders SVG-backed ACC geometry`, () => {
    const boundaries = getTrackBoundariesByOrdinal(ordinal, "acc");
    const racing = getTrackRacelineByOrdinal(ordinal, "acc");
    expect(boundaries, slug).not.toBeNull();
    expect(racing, slug).not.toBeNull();
    const flip = needsTrackFlip("acc");
    const display = (points: Pt[]) => flip ? flipPoints(points) : points;
    const left = display(boundaries!.leftEdge);
    const right = display(boundaries!.rightEdge);
    const center = display(boundaries!.centerLine!);
    const race = display(racing!);
    const pit = boundaries!.pitLane ? display(boundaries!.pitLane) : null;
    const projection = makeTrackProjection([...left, ...right, ...center, ...race, ...(pit ?? [])], {
      width: 1200,
      height: 900,
      padPx: 70,
    });
    expect(projection, slug).not.toBeNull();
    const path = (points: Pt[], color: string, width: number, closed: boolean) => {
      const d = points.map((point, index) => {
        const p = projection!.project(point);
        return `${index ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
      }).join(" ");
      return `<path d="${d}${closed ? " Z" : ""}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" />`;
    };
    const start = projection!.project(center[0]);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900">
<rect width="1200" height="900" fill="#111827" />
<text x="24" y="30" fill="#ffffff" font-family="monospace" font-size="19">ACC ${slug} — SVG-derived geometry</text>
<text x="24" y="53" fill="#60a5fa" font-family="monospace" font-size="13">Blue: left edge</text>
<text x="185" y="53" fill="#fb7185" font-family="monospace" font-size="13">Red: right edge</text>
<text x="350" y="53" fill="#4ade80" font-family="monospace" font-size="13">Green: aligned centre</text>
<text x="580" y="53" fill="#fbbf24" font-family="monospace" font-size="13">Yellow: racing line</text>
<text x="800" y="53" fill="#a78bfa" font-family="monospace" font-size="13">Purple: pit lane</text>
${path(left, "#60a5fa", 2, true)}
${path(right, "#fb7185", 2, true)}
${path(center, "#4ade80", 1.5, true)}
${path(race, "#fbbf24", 1.5, true)}
${pit ? path(pit, "#a78bfa", 2, false) : ""}
<circle cx="${start.x.toFixed(2)}" cy="${start.y.toFixed(2)}" r="6" fill="#ffffff" stroke="#111827" stroke-width="2" />
</svg>\n`;
    writeFileSync(resolve(outputDir, `${slug}-acc.svg`), svg);
  });
}
