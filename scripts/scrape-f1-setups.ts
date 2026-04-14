/**
 * Scrape F1 25 setups from f1laps.com AND simracingsetup.com.
 * Each track gets its own JSON. All tracks + both sources scraped in parallel.
 *
 * Usage: bun scripts/scrape-f1-setups.ts
 */
import { mkdirSync, existsSync, readFileSync } from "fs";

const TRACK_MAP: Record<string, { ordinal: number; name: string; srsSlug: string }> = {
  australia:     { ordinal: 0,  name: "Melbourne Grand Prix Circuit",              srsSlug: "australian-gp-setups" },
  china:         { ordinal: 2,  name: "Shanghai International Circuit",            srsSlug: "china-gp-setups" },
  japan:         { ordinal: 13, name: "Suzuka International Racing Course",        srsSlug: "japanese-gp-setups" },
  bahrain:       { ordinal: 3,  name: "Bahrain International Circuit",             srsSlug: "bahrain-gp-setups" },
  saudi_arabia:  { ordinal: 29, name: "Jeddah Corniche Circuit",                   srsSlug: "saudi-arabian-gp-setups" },
  miami:         { ordinal: 30, name: "Miami International Autodrome",             srsSlug: "miami-gp-setups" },
  imola:         { ordinal: 27, name: "Autodromo Enzo e Dino Ferrari",             srsSlug: "imola-gp-setups" },
  monaco:        { ordinal: 5,  name: "Circuit de Monaco",                         srsSlug: "monaco-gp-setups" },
  spain:         { ordinal: 4,  name: "Circuit de Barcelona-Catalunya",            srsSlug: "spanish-gp-setups" },
  canada:        { ordinal: 6,  name: "Circuit Gilles Villeneuve",                 srsSlug: "canadian-gp-setups" },
  austria:       { ordinal: 17, name: "Red Bull Ring",                             srsSlug: "austrian-gp-setups" },
  silverstone:   { ordinal: 7,  name: "Silverstone Circuit",                       srsSlug: "british-gp-setups" },
  spa:           { ordinal: 10, name: "Circuit de Spa-Francorchamps",              srsSlug: "belgium-gp-setups" },
  hungary:       { ordinal: 9,  name: "Hungaroring",                               srsSlug: "hungarian-gp-setups" },
  netherlands:   { ordinal: 26, name: "Circuit Zandvoort",                         srsSlug: "netherlands-gp-setups" },
  monza:         { ordinal: 11, name: "Autodromo Nazionale Monza",                 srsSlug: "italian-gp-setups" },
  azerbaijan:    { ordinal: 20, name: "Baku City Circuit",                         srsSlug: "azerbaijan-gp-setups" },
  singapore:     { ordinal: 12, name: "Marina Bay Street Circuit",                 srsSlug: "singapore-gp-setups" },
  usa:           { ordinal: 15, name: "Circuit of the Americas",                   srsSlug: "united-states-gp-setups" },
  mexico:        { ordinal: 19, name: "Autodromo Hermanos Rodriguez",              srsSlug: "mexican-gp-setups" },
  brazil:        { ordinal: 16, name: "Autodromo Jose Carlos Pace",                srsSlug: "brazilian-gp-setups" },
  las_vegas:     { ordinal: 31, name: "Las Vegas Street Circuit",                  srsSlug: "las-vegas-gp-setups" },
  qatar:         { ordinal: 32, name: "Lusail International Circuit",              srsSlug: "qatar-gp-setups" },
  abudhabi:      { ordinal: 14, name: "Yas Marina Circuit",                        srsSlug: "abu-dhabi-gp-setups" },
};

const OUT_DIR = "shared/tunes/f1-25";
const F1LAPS = "https://www.f1laps.com";
const SRS = "https://simracingsetup.com";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "RaceIQ-SetupScraper/1.0 (racing telemetry app)" },
      });
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return res.text();
    } catch (err) {
      if (attempt < retries - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

/** Run async tasks with max concurrency */
async function pooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

// ── Setup value extraction (shared) ─────────────────────────────────────

function parseSetupValues(html: string, labelMap: Record<string, RegExp>): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [key, re] of Object.entries(labelMap)) {
    const m = html.match(re);
    result[key] = m ? parseFloat(m[1]) : null;
  }
  return result;
}

// ── f1laps ──────────────────────────────────────────────────────────────

function f1lapsExtractUuids(html: string, slug: string): string[] {
  const re = new RegExp(`href="/f1-25/setups/${slug}/([0-9a-f-]{36})/"`, "gi");
  const uuids = new Set<string>();
  let m;
  while ((m = re.exec(html)) !== null) uuids.add(m[1]);
  return [...uuids];
}

function f1lapsParseDetail(html: string) {
  function val(label: string): number | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = html.match(new RegExp(
      escaped + `\\s*</dt>\\s*<dd[^>]*>[\\s\\S]*?</dd>\\s*<dd[^>]*>\\s*(-?\\d+\\.?\\d*)[^<]*</dd>`, "i"
    ));
    return m ? parseFloat(m[1]) : null;
  }

  const teamMatch = html.match(/<dd>((?:McLaren|Red Bull Racing|Ferrari|Mercedes|Aston Martin|Alpine|Williams|Haas F1 Team|Kick Sauber|RB|F1 Custom Team)[^<]*)<\/dd>/i);
  const authorMatch = html.match(/setup[^"]*by\s+(\w+)/i);
  const lapMatch = html.match(/(\d:\d{2}\.\d{3})/);
  let sessionType = "Time Trial";
  if (/time.?trial/i.test(html)) sessionType = "Time Trial";
  else if (/qualifying/i.test(html)) sessionType = "Qualifying";
  else if (/\brace\b/i.test(html)) sessionType = "Race";
  const inputDevice = /&nbsp;Controller/i.test(html) ? "controller" : /&nbsp;Wheel/i.test(html) ? "wheel" : "";

  return {
    team: teamMatch?.[1]?.trim() ?? "",
    author: authorMatch?.[1] ?? "",
    lapTime: lapMatch?.[1] ?? "",
    sessionType,
    inputDevice,
    weather: /&nbsp;Wet/i.test(html) ? "Wet" : "Dry",
    setup: {
      frontWing: val("Front Wing"),
      rearWing: val("Rear Wing"),
      diffOnThrottle: val("Differential Adjustment On Throttle"),
      diffOffThrottle: val("Differential Adjustment Off Throttle"),
      frontCamber: val("Front Camber"),
      rearCamber: val("Rear Camber"),
      frontToe: val("Front Toe"),
      rearToe: val("Rear Toe"),
      frontSuspension: val("Front Suspension"),
      rearSuspension: val("Rear Suspension"),
      frontAntiRollBar: val("Front Anti-Roll Bar"),
      rearAntiRollBar: val("Rear Anti-Roll Bar"),
      frontRideHeight: val("Front Ride Height"),
      rearRideHeight: val("Rear Ride Height"),
      brakePressure: val("Break Pressure"),
      frontBrakeBias: val("Front Break Bias"),
      frontRightTyrePressure: val("Front Right Tyre Pressure"),
      frontLeftTyrePressure: val("Front Left Tyre Pressure"),
      rearRightTyrePressure: val("Rear Right Tyre Pressure"),
      rearLeftTyrePressure: val("Rear Left Tyre Pressure"),
    },
  };
}

async function scrapeF1Laps(slug: string): Promise<any[]> {
  // Scrape both dry and wet listing pages in parallel
  const [dryHtml, wetHtml] = await Promise.all([
    fetchText(`${F1LAPS}/f1-25/setups/${slug}/`),
    fetchText(`${F1LAPS}/f1-25/setups/${slug}/wet/`).catch(() => ""),
  ]);
  const dryUuids = f1lapsExtractUuids(dryHtml, slug);
  const wetUuids = f1lapsExtractUuids(wetHtml, slug);
  const allUuids = [...new Set([...dryUuids, ...wetUuids])];
  const wetSet = new Set(wetUuids.filter(u => !dryUuids.includes(u)));

  const results: any[] = [];
  await pooled(allUuids, 3, async (uuid) => {
    try {
      const url = `${F1LAPS}/f1-25/setups/${slug}/${uuid}/`;
      const html = await fetchText(url);
      const parsed = f1lapsParseDetail(html);
      if (wetSet.has(uuid) && parsed.weather === "Dry") parsed.weather = "Wet";
      results.push({ ...parsed, source: url, provider: "f1laps" });
    } catch {}
    await sleep(300);
  });
  return results;
}

// ── simracingsetup.com ──────────────────────────────────────────────────

type GuideSection = { heading: string; body: string };
type GuideEntry = { source: string; videoUrl: string; sections: GuideSection[]; setupTips: string; drivingTips: string };

function srsParseListingPage(html: string): { setupUrls: string[]; videoUrl: string; trackGuide: GuideSection[]; setupTips: string; drivingTips: string } {
  // Setup detail URLs
  const setupUrls: string[] = [];
  const urlRe = /href="(https:\/\/simracingsetup\.com\/setups\/f1-25-setups\/[^"]+)"/gi;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    if (!m[1].includes("-pro")) setupUrls.push(m[1]);
  }

  // YouTube
  const vidMatch = html.match(/(?:tube\.rvere\.com\/embed\?v=|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  const videoUrl = vidMatch ? `https://www.youtube.com/watch?v=${vidMatch[1]}` : "";

  function decodeEntities(s: string): string {
    return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "");
  }

  function toPlainText(fragment: string): string {
    return decodeEntities(
      fragment
        .replace(/<li[^>]*>/gi, "\n• ")
        .replace(/<\/li>/gi, "")
        .replace(/<\/?(strong|em|span|a)[^>]*>/gi, "")
        .replace(/<\/?(p|ul|ol|div|br|h[2-6])[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
    ).replace(/✅/g, "\n• ").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/• \n/g, "• ").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** Extract a range of HTML between a start label and end markers, return as structured sections. */
  function extractSections(startLabel: string, endLabels: string[]): GuideSection[] {
    const labelIdx = html.indexOf(startLabel);
    if (labelIdx < 0) return [];
    // Backtrack to the opening <h tag so the first heading is fully captured
    const hTagStart = html.lastIndexOf("<h", labelIdx);
    const start = hTagStart >= 0 && hTagStart > labelIdx - 200 ? hTagStart : labelIdx;
    let end = html.length;
    for (const marker of endLabels) {
      const idx = html.indexOf(marker, labelIdx + startLabel.length);
      if (idx > 0 && idx < end) end = idx;
    }
    const chunk = html.slice(start, end);

    // Split on h3/h4 headings
    const headingRe = /<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
    const sections: GuideSection[] = [];
    let lastIdx = 0;
    let pendingHeading = "";
    let hm: RegExpExecArray | null;

    while ((hm = headingRe.exec(chunk)) !== null) {
      if (pendingHeading) {
        const body = toPlainText(chunk.slice(lastIdx, hm.index));
        if (body) sections.push({ heading: pendingHeading, body });
      }
      pendingHeading = decodeEntities(hm[1].replace(/<[^>]*>/g, "")).trim();
      lastIdx = hm.index + hm[0].length;
    }
    // Last section
    if (pendingHeading) {
      const body = toPlainText(chunk.slice(lastIdx));
      if (body) sections.push({ heading: pendingHeading, body });
    }
    // Fallback: no headings found, treat whole block as one section
    if (sections.length === 0) {
      const body = toPlainText(chunk);
      if (body) sections.push({ heading: "", body });
    }
    return sections;
  }

  function extractPlainSection(startLabel: string, endLabels: string[]): string {
    const start = html.indexOf(startLabel);
    if (start < 0) return "";
    let end = html.length;
    for (const marker of endLabels) {
      const idx = html.indexOf(marker, start + startLabel.length);
      if (idx > 0 && idx < end) end = idx;
    }
    return toPlainText(html.slice(start, end));
  }

  const endMarkers = ["Car Setup Tips", "Setup Tips", "Driving Tips", "Recommended race strategy", "Race Strategy", "race strategy for", "high or low downforce", "How to create", "Pirelli", "car-setup-archive"];
  const trackGuide = (
    extractSections("Sector 1", endMarkers).length ? extractSections("Sector 1", endMarkers) :
    extractSections("General Tips", endMarkers).length ? extractSections("General Tips", endMarkers) :
    extractSections("Track guide overview for", endMarkers).length ? extractSections("Track guide overview for", endMarkers) :
    extractSections("Turns 1", endMarkers).length ? extractSections("Turns 1", endMarkers) :
    extractSections("Turn 1", endMarkers)
  );
  const setupTips = extractPlainSection("Car Setup Tips", ["Driving Tips", ...endMarkers.slice(3)])
    || extractPlainSection("Setup Tips", ["Driving Tips", ...endMarkers.slice(3)]);
  const drivingTips = extractPlainSection("Driving Tips", endMarkers.slice(3));

  return { setupUrls: [...new Set(setupUrls)], videoUrl, trackGuide, setupTips, drivingTips };
}

function srsParseDetail(html: string) {
  // Setup values: <div class="setup-part-name">Label:</div>\n<div class="setup-part-number">VALUE</div>
  function val(label: string): number | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = html.match(new RegExp(escaped + `[^<]*</div>\\s*<div class="setup-part-number">\\s*(-?\\d+\\.?\\d*)`, "i"));
    return m ? parseFloat(m[1]) : null;
  }

  // Lap time from title or content
  const lapMatch = html.match(/(\d:\d{2}[\.:]\d{3})/);
  const lapTime = lapMatch ? lapMatch[1].replace(".", ":").replace(/:(\d{3})$/, ".$1") : "";

  // Session type
  const sessionMatch = html.match(/<strong>(Race|Time Trial|Qualifying)<\/strong>/i);
  const sessionType = sessionMatch ? sessionMatch[1] : "";

  // Input device
  const inputDevice = /fa-gamepad-modern/i.test(html) ? "controller" : /fa-steering-wheel/i.test(html) ? "wheel" : "";

  // Weather
  const weather = /fa-cloud-rain/i.test(html) || /wet/i.test(html.match(/<title>[^<]*/i)?.[0] ?? "") ? "Wet" : "Dry";

  // Per-setup video
  const videoMatch = html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  const videoUrl = videoMatch ? `https://www.youtube.com/watch?v=${videoMatch[1]}` : "";

  // Team from title: "... Ferrari Dry ..." or "... McLaren Wet ..."
  const teams = ["Ferrari", "McLaren", "Red Bull", "Mercedes", "Aston Martin", "Alpine", "Williams", "Haas", "Kick Sauber", "RB", "Racing Bulls"];
  const titleMatch = html.match(/<title>([^<]+)/i);
  const title = titleMatch?.[1] ?? "";
  const team = teams.find(t => title.toLowerCase().includes(t.toLowerCase())) ?? "";

  return {
    team,
    author: "SimRacingSetup",
    videoUrl,
    lapTime,
    sessionType,
    inputDevice,
    weather,
    setup: {
      frontWing: val("Front Wing Aero"),
      rearWing: val("Rear Wing Aero"),
      diffOnThrottle: val("Differential Adjustment On Throttle"),
      diffOffThrottle: val("Differential Adjustment Off Throttle"),
      frontCamber: val("Front Camber"),
      rearCamber: val("Rear Camber"),
      frontToe: val("Front Toe"),
      rearToe: val("Rear Toe"),
      frontSuspension: val("Front Suspension"),
      rearSuspension: val("Rear Suspension"),
      frontAntiRollBar: val("Front Anti-Roll Bar"),
      rearAntiRollBar: val("Rear Anti-Roll Bar"),
      frontRideHeight: val("Front Ride Height"),
      rearRideHeight: val("Rear Ride Height"),
      brakePressure: val("Brake Pressure"),
      frontBrakeBias: val("Brake Bias"),
      frontRightTyrePressure: val("Front Right Tyre Pressure"),
      frontLeftTyrePressure: val("Front Left Tyre Pressure"),
      rearRightTyrePressure: val("Rear Right Tyre Pressure"),
      rearLeftTyrePressure: val("Rear Left Tyre Pressure"),
    },
  };
}

async function scrapeSRS(srsSlug: string): Promise<{ setups: any[]; videoUrl: string; guideUrl: string; trackGuide: string; setupTips: string; drivingTips: string }> {
  const guideUrl = `${SRS}/setups/f1-25/${srsSlug}/`;
  const listHtml = await fetchText(guideUrl);
  const { setupUrls, videoUrl, trackGuide, setupTips, drivingTips } = srsParseListingPage(listHtml);

  const setups = (await Promise.all(setupUrls.map(async (url) => {
    try {
      const html = await fetchText(url);
      const parsed = { ...srsParseDetail(html), source: url, provider: "simracingsetup" };
      // Skip setups without lap times
      if (!parsed.lapTime) return null;
      return parsed;
    } catch { return null; }
  }))).filter(Boolean);

  return { setups, videoUrl, guideUrl, trackGuide, setupTips, drivingTips };
}

// ── overtake.gg ─────────────────────────────────────────────────────────

const OVERTAKE_BASE = "https://www.overtake.gg/news/f1-25-track-guides.3245";

const OVERTAKE_TRACK_MAP: Record<string, string> = {
  australia:   "page/australia-albert-park.348/",
  china:       "page/china-shanghai-international-circuit.353/",
  japan:       "page/japan-suzuka.354/",
  bahrain:     "page/bahrain-bahrain-international-circuit.352/",
  saudi_arabia:"page/saudi-arabia-jeddah-corniche-circuit.355/",
  miami:       "page/usa-miami-international-autodrome.356/",
  imola:       "page/italy-autodromo-internazionale-enzo-e-dino-ferrari.351/",
  monaco:      "page/monaco-circuit-de-monaco.357/",
  spain:       "page/spain-barcelona.343/",
  canada:      "page/canada-montr%C3%A9al-circuit-gilles-villeneuve.345/",
  austria:     "page/austria-red-bull-ring.344/",
  silverstone: "page/great-britian-silverstone.346/",
  spa:         "page/belgium-spa-francorchamps.347/",
  hungary:     "page/hungary-hungaroring.349/",
  netherlands: "page/netherlands-zandvoort.358/",
  monza:       "page/italy-monza.350/",
  azerbaijan:  "page/azerbaijan-baku.359/",
  singapore:   "page/singapore-marina-bay.360/",
  usa:         "page/usa-circuit-of-the-americas.361/",
  mexico:      "page/mexico-hermanos-rodriguez.362/",
  brazil:      "page/brazil-interlagos.363/",
  las_vegas:   "page/usa-las-vegas-strip-circuit.364/",
  qatar:       "page/qatar-lusail.365/",
  abudhabi:    "page/abu-dhabi-yas-marina.366/",
};

function overtakeExtractSections(html: string): GuideSection[] {
  function decodeEntities(s: string): string {
    return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "");
  }
  function toPlainText(fragment: string): string {
    return decodeEntities(
      fragment
        .replace(/<li[^>]*>/gi, "\n• ")
        .replace(/<\/li>/gi, "")
        .replace(/<\/?(strong|em|span|a)[^>]*>/gi, "")
        .replace(/<\/?(p|ul|ol|div|br|h[2-6])[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
    ).replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Find the article content — starts after "Table of contents" nav, ends before "Continue Reading" or "More in Guides"
  const contentStart = html.indexOf('class="bbWrapper"');
  if (contentStart < 0) return [];
  const contentEnd = Math.min(
    ...["Continue Reading", "More in Guides", "class=\"p-article-tag-list\"", "Next page:", "Previous page:", "Last edited:"].map(m => {
      const i = html.indexOf(m, contentStart);
      return i > 0 ? i : html.length;
    })
  );
  const content = html.slice(contentStart, contentEnd);

  const headingRe = /<b>(Sector \d[^<]*)<\/b>|<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
  const sections: GuideSection[] = [];
  let lastIdx = 0;
  let pendingHeading = "";
  let hm: RegExpExecArray | null;

  while ((hm = headingRe.exec(content)) !== null) {
    if (pendingHeading) {
      const body = toPlainText(content.slice(lastIdx, hm.index));
      if (body.length > 20) sections.push({ heading: pendingHeading, body });
    }
    pendingHeading = decodeEntities((hm[1] || hm[2] || "").replace(/<[^>]*>/g, "")).trim();
    lastIdx = hm.index + hm[0].length;
  }
  if (pendingHeading) {
    const body = toPlainText(content.slice(lastIdx));
    if (body.length > 20) sections.push({ heading: pendingHeading, body });
  }
  return sections;
}

async function scrapeOvertake(slug: string): Promise<GuideSection[]> {
  const pagePath = OVERTAKE_TRACK_MAP[slug];
  if (!pagePath) return [];
  const url = `${OVERTAKE_BASE}/${pagePath}`;
  const html = await fetchText(url);
  return overtakeExtractSections(html);
}

// ── Main ────────────────────────────────────────────────────────────────

async function scrapeTrack(slug: string) {
  const track = TRACK_MAP[slug];

  // Scrape all sources in parallel
  const [f1lapsSetups, srsData, overtakeSections] = await Promise.all([
    scrapeF1Laps(slug).catch(err => { console.error(`  [${slug}] f1laps: ${(err as Error).message}`); return []; }),
    scrapeSRS(track.srsSlug).catch(err => { console.error(`  [${slug}] srs: ${(err as Error).message}`); return { setups: [], videoUrl: "", guideUrl: "", trackGuide: [] as GuideSection[], setupTips: "", drivingTips: "" }; }),
    scrapeOvertake(slug).catch(err => { console.error(`  [${slug}] overtake: ${(err as Error).message}`); return [] as GuideSection[]; }),
  ]);

  return { slug, track, f1lapsSetups, srsData, overtakeSections };
}

function ensureSourceMeta(sourceSlug: string, name: string, domain: string, url: string) {
  const dir = `${OUT_DIR}/${sourceSlug}`;
  mkdirSync(dir, { recursive: true });
  const metaPath = `${dir}/_source.json`;
  if (!existsSync(metaPath)) {
    Bun.write(metaPath, JSON.stringify({ name, slug: sourceSlug, domain, url, lastScraped: "" }, null, 2));
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const slugs = Object.keys(TRACK_MAP);

  // Ensure scrape metadata
  ensureSourceMeta("f1laps", "F1Laps", "f1laps.com", "https://www.f1laps.com/");
  ensureSourceMeta("simracingsetup", "SimRacingSetup", "simracingsetup.com", "https://simracingsetup.com/");

  ensureSourceMeta("overtake", "Overtake.gg", "overtake.gg", "https://www.overtake.gg/news/f1-25-track-guides.3245/");

  console.log(`Scraping ${slugs.length} tracks (f1laps + simracingsetup + overtake, 4 concurrent)...\n`);

  let totalF1L = 0, totalSRS = 0;
  await pooled(slugs, 4, async (slug) => {
    const { track, f1lapsSetups, srsData, overtakeSections } = await scrapeTrack(slug);

    // Write track identity file
    await Bun.write(`${OUT_DIR}/${slug}.json`, JSON.stringify({
      trackSlug: slug,
      trackName: track.name,
      trackOrdinal: track.ordinal,
    }, null, 2));

    // Write f1laps setups
    const f1lDir = `${OUT_DIR}/f1laps/${slug}`;
    mkdirSync(f1lDir, { recursive: true });
    // Merge with existing (dedup by source URL)
    let existingF1L: any[] = [];
    try { existingF1L = JSON.parse(readFileSync(`${f1lDir}/setups.json`, "utf-8")); } catch {}
    const existingUrls = new Set(existingF1L.map((s: any) => s.source));
    const mergedF1L = [...existingF1L, ...f1lapsSetups.filter((s: any) => !existingUrls.has(s.source))];
    await Bun.write(`${f1lDir}/setups.json`, JSON.stringify(mergedF1L, null, 2));

    // Write simracingsetup setups + meta
    const srsDir = `${OUT_DIR}/simracingsetup/${slug}`;
    mkdirSync(srsDir, { recursive: true });
    let existingSRS: any[] = [];
    try { existingSRS = JSON.parse(readFileSync(`${srsDir}/setups.json`, "utf-8")); } catch {}
    const existingSrsUrls = new Set(existingSRS.map((s: any) => s.source));
    const mergedSRS = [...existingSRS, ...srsData.setups.filter((s: any) => !existingSrsUrls.has(s.source))];
    await Bun.write(`${srsDir}/setups.json`, JSON.stringify(mergedSRS, null, 2));

    // Write _meta.json for simracingsetup (guide, video, etc.) — upsert: keep existing values if scrape returns empty
    let existingMeta: any = {};
    try { existingMeta = JSON.parse(readFileSync(`${srsDir}/_meta.json`, "utf-8")); } catch {}
    // trackGuide is an array of { source, videoUrl, sections, setupTips, drivingTips } — upsert by source URL
    const existingGuides: GuideEntry[] = Array.isArray(existingMeta.trackGuide)
      ? existingMeta.trackGuide
      : [];
    const guideUrl = srsData.guideUrl || existingMeta.guideUrl || "";
    const hasNewGuide = srsData.trackGuide.length > 0 || srsData.setupTips || srsData.drivingTips;
    if (hasNewGuide) {
      const idx = existingGuides.findIndex(g => g.source === guideUrl);
      const prev = existingGuides[idx];
      const entry: GuideEntry = {
        source: guideUrl,
        videoUrl: srsData.videoUrl || prev?.videoUrl || "",
        sections: srsData.trackGuide.length > 0 ? srsData.trackGuide : (prev?.sections ?? []),
        setupTips: srsData.setupTips || prev?.setupTips || "",
        drivingTips: srsData.drivingTips || prev?.drivingTips || "",
      };
      if (idx >= 0) existingGuides[idx] = entry;
      else existingGuides.push(entry);
    }
    await Bun.write(`${srsDir}/_meta.json`, JSON.stringify({
      trackGuide: existingGuides,
    }, null, 2));

    // Write overtake guide
    if (OVERTAKE_TRACK_MAP[slug]) {
      const overtakeDir = `${OUT_DIR}/overtake/${slug}`;
      mkdirSync(overtakeDir, { recursive: true });
      const overtakeMetaPath = `${overtakeDir}/_meta.json`;
      let existingOvertakeMeta: any = {};
      try { existingOvertakeMeta = JSON.parse(readFileSync(overtakeMetaPath, "utf-8")); } catch {}
      const overtakeGuideUrl = `${OVERTAKE_BASE}/${OVERTAKE_TRACK_MAP[slug]}`;
      const existingOvertakeGuides: GuideEntry[] = Array.isArray(existingOvertakeMeta.trackGuide) ? existingOvertakeMeta.trackGuide : [];
      const hasNewOvertake = overtakeSections.length > 0;
      if (hasNewOvertake || existingOvertakeGuides.length === 0) {
        const idx = existingOvertakeGuides.findIndex(g => g.source === overtakeGuideUrl);
        const prev = existingOvertakeGuides[idx];
        const entry: GuideEntry = {
          source: overtakeGuideUrl,
          videoUrl: prev?.videoUrl || "",
          sections: overtakeSections.length > 0 ? overtakeSections : (prev?.sections ?? []),
          setupTips: prev?.setupTips || "",
          drivingTips: prev?.drivingTips || "",
        };
        if (idx >= 0) existingOvertakeGuides[idx] = entry;
        else existingOvertakeGuides.push(entry);
        await Bun.write(overtakeMetaPath, JSON.stringify({ trackGuide: existingOvertakeGuides }, null, 2));
      }
    }

    totalF1L += mergedF1L.length;
    totalSRS += mergedSRS.length;
    console.log(`  ✓ ${slug.padEnd(14)} f1laps: ${mergedF1L.length} | srs: ${mergedSRS.length} | srs-sections: ${srsData.trackGuide.length} | overtake: ${overtakeSections.length}`);
  });

  // Update lastScraped in _source.json
  const ts = new Date().toISOString();
  for (const src of ["f1laps", "simracingsetup", "overtake"]) {
    const metaPath = `${OUT_DIR}/${src}/_source.json`;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.lastScraped = ts;
    await Bun.write(metaPath, JSON.stringify(meta, null, 2));
  }

  console.log(`\nDone! ${totalF1L + totalSRS} total setups (f1laps: ${totalF1L}, simracingsetup: ${totalSRS}) across ${slugs.length} tracks`);
}

main().catch(console.error);
