import { resolve } from "path";
import { runPool } from "../../lib/pool";
import { scrape as scrapeF1Laps } from "./f1laps";
import { scrape as scrapeSrs } from "./simracing-setup";
import { scrape as scrapeOvertake, sourceUrl } from "./overtake";
import { ensureSourceMeta, updateSourceTimestamps, writeTrack } from "./output";
import { OUT_DIR, SrsData, TRACK_MAP } from "./types";

const outDir = resolve(import.meta.dir, "../../../", OUT_DIR);

export async function main(): Promise<void> {
  const slugs = Object.keys(TRACK_MAP);
  await Promise.all([
    ensureSourceMeta(outDir, "f1laps", "F1Laps", "f1laps.com", "https://www.f1laps.com/"),
    ensureSourceMeta(outDir, "simracingsetup", "SimRacingSetup", "simracingsetup.com", "https://simracingsetup.com/"),
    ensureSourceMeta(outDir, "overtake", "Overtake.gg", "overtake.gg", "https://www.overtake.gg/news/f1-25-track-guides.3245/"),
  ]);
  console.log(`Scraping ${slugs.length} tracks (f1laps + simracingsetup + overtake, 4 concurrent)...\n`);
  let totalF1L = 0;
  let totalSRS = 0;
  await runPool(slugs, 4, async slug => {
    const track = TRACK_MAP[slug];
    const [f1lapsSetups, srsData, overtakeSections] = await Promise.all([
      scrapeF1Laps(slug).catch(error => { console.error(`  [${slug}] f1laps: ${(error as Error).message}`); return []; }),
      scrapeSrs(track.srsSlug).catch(error => { console.error(`  [${slug}] srs: ${(error as Error).message}`); return { setups: [], videoUrl: "", guideUrl: "", trackGuide: [], setupTips: "", drivingTips: "" } satisfies SrsData; }),
      scrapeOvertake(slug).catch(error => { console.error(`  [${slug}] overtake: ${(error as Error).message}`); return []; }),
    ]);
    const totals = await writeTrack(outDir, slug, track, f1lapsSetups, srsData, overtakeSections, sourceUrl(slug));
    totalF1L += totals.f1laps;
    totalSRS += totals.srs;
    console.log(`  ✓ ${slug.padEnd(14)} f1laps: ${totals.f1laps} | srs: ${totals.srs} | srs-sections: ${srsData.trackGuide.length} | overtake: ${overtakeSections.length}`);
  });
  await updateSourceTimestamps(outDir, new Date().toISOString());
  console.log(`\nDone! ${totalF1L + totalSRS} total setups (f1laps: ${totalF1L}, simracingsetup: ${totalSRS}) across ${slugs.length} tracks`);
}
