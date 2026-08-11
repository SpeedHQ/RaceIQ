import { fetchText } from "../../lib/http";
import { type GuideSection, SRS, type SetupRecord, type SrsData } from "./types";

const HEADERS = { "User-Agent": "RaceIQ-SetupScraper/1.0 (racing telemetry app)" };

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "");
}

function toPlainText(fragment: string): string {
  return decodeEntities(fragment.replace(/<li[^>]*>/gi, "\n• ").replace(/<\/li>/gi, "")
    .replace(/<\/?(strong|em|span|a)[^>]*>/gi, "").replace(/<\/?(p|ul|ol|div|br|h[2-6])[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")).replace(/✅/g, "\n• ").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n")
    .replace(/• \n/g, "• ").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseListingPage(html: string): { setupUrls: string[]; videoUrl: string; trackGuide: GuideSection[]; setupTips: string; drivingTips: string } {
  const setupUrls: string[] = [];
  const urlRe = /href="(https:\/\/simracingsetup\.com\/setups\/f1-25-setups\/[^" ]+)"/gi;
  while (true) {
    const match = urlRe.exec(html);
    if (match === null) break;
    if (!match[1].includes("-pro")) setupUrls.push(match[1]);
  }
  const vidMatch = html.match(/(?:tube\.rvere\.com\/embed\?v=|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  const videoUrl = vidMatch ? `https://www.youtube.com/watch?v=${vidMatch[1]}` : "";

  function extractSections(startLabel: string, endLabels: string[]): GuideSection[] {
    const labelIdx = html.indexOf(startLabel);
    if (labelIdx < 0) return [];
    const hTagStart = html.lastIndexOf("<h", labelIdx);
    const start = hTagStart >= 0 && hTagStart > labelIdx - 200 ? hTagStart : labelIdx;
    let end = html.length;
    for (const marker of endLabels) {
      const idx = html.indexOf(marker, labelIdx + startLabel.length);
      if (idx > 0 && idx < end) end = idx;
    }
    const chunk = html.slice(start, end);
    const headingRe = /<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
    const sections: GuideSection[] = [];
    let lastIdx = 0;
    let pendingHeading = "";
    while (true) {
      const headingMatch = headingRe.exec(chunk);
      if (headingMatch === null) break;
      if (pendingHeading) {
        const body = toPlainText(chunk.slice(lastIdx, headingMatch.index));
        if (body) sections.push({ heading: pendingHeading, body });
      }
      pendingHeading = decodeEntities(headingMatch[1].replace(/<[^>]*>/g, "")).trim();
      lastIdx = headingMatch.index + headingMatch[0].length;
    }
    if (pendingHeading) {
      const body = toPlainText(chunk.slice(lastIdx));
      if (body) sections.push({ heading: pendingHeading, body });
    }
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
  const trackGuide = ["Sector 1", "General Tips", "Track guide overview for", "Turns 1", "Turn 1"].reduce<GuideSection[]>((found, label) => found.length ? found : extractSections(label, endMarkers), []);
  const setupTips = extractPlainSection("Car Setup Tips", ["Driving Tips", ...endMarkers.slice(3)]) || extractPlainSection("Setup Tips", ["Driving Tips", ...endMarkers.slice(3)]);
  return { setupUrls: [...new Set(setupUrls)], videoUrl, trackGuide, setupTips, drivingTips: extractPlainSection("Driving Tips", endMarkers.slice(3)) };
}

export function parseDetail(html: string): SetupRecord {
  const val = (label: string): number | null => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`${escaped}[^<]*</div>\\s*<div class="setup-part-number">\\s*(-?\\d+\\.?\\d*)`, "i"));
    return match ? parseFloat(match[1]) : null;
  };
  const lapMatch = html.match(/(\d:\d{2}[.:]\d{3})/);
  const teams = ["Ferrari", "McLaren", "Red Bull", "Mercedes", "Aston Martin", "Alpine", "Williams", "Haas", "Kick Sauber", "RB", "Racing Bulls"];
  const title = html.match(/<title>([^<]+)/i)?.[1] ?? "";
  const videoMatch = html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  return {
    team: teams.find(team => title.toLowerCase().includes(team.toLowerCase())) ?? "",
    author: "SimRacingSetup",
    videoUrl: videoMatch ? `https://www.youtube.com/watch?v=${videoMatch[1]}` : "",
    lapTime: lapMatch ? lapMatch[1].replace(".", ":").replace(/:(\d{3})$/, ".$1") : "",
    sessionType: html.match(/<strong>(Race|Time Trial|Qualifying)<\/strong>/i)?.[1] ?? "",
    inputDevice: /fa-gamepad-modern/i.test(html) ? "controller" : /fa-steering-wheel/i.test(html) ? "wheel" : "",
    weather: /fa-cloud-rain/i.test(html) || /wet/i.test(html.match(/<title>[^<]*/i)?.[0] ?? "") ? "Wet" : "Dry",
    setup: {
      frontWing: val("Front Wing Aero"), rearWing: val("Rear Wing Aero"), diffOnThrottle: val("Differential Adjustment On Throttle"), diffOffThrottle: val("Differential Adjustment Off Throttle"), frontCamber: val("Front Camber"), rearCamber: val("Rear Camber"), frontToe: val("Front Toe"), rearToe: val("Rear Toe"), frontSuspension: val("Front Suspension"), rearSuspension: val("Rear Suspension"), frontAntiRollBar: val("Front Anti-Roll Bar"), rearAntiRollBar: val("Rear Anti-Roll Bar"), frontRideHeight: val("Front Ride Height"), rearRideHeight: val("Rear Ride Height"), brakePressure: val("Brake Pressure"), frontBrakeBias: val("Brake Bias"), frontRightTyrePressure: val("Front Right Tyre Pressure"), frontLeftTyrePressure: val("Front Left Tyre Pressure"), rearRightTyrePressure: val("Rear Right Tyre Pressure"), rearLeftTyrePressure: val("Rear Left Tyre Pressure"),
    },
  };
}

export async function scrape(srsSlug: string): Promise<SrsData> {
  const guideUrl = `${SRS}/setups/f1-25/${srsSlug}/`;
  const listing = parseListingPage(await fetchText(guideUrl, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) }));
  const setups = (await Promise.all(listing.setupUrls.map(async (url): Promise<SetupRecord | null> => {
    try {
      const parsed: SetupRecord = {
        ...parseDetail(await fetchText(url, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) })),
        source: url,
        provider: "simracingsetup",
      };
      return typeof parsed.lapTime === "string" && parsed.lapTime.length > 0 ? parsed : null;
    } catch { return null; }
  }))).filter((setup): setup is SetupRecord => setup !== null);
  return { setups, videoUrl: listing.videoUrl, guideUrl, trackGuide: listing.trackGuide, setupTips: listing.setupTips, drivingTips: listing.drivingTips };
}
